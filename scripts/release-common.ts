// tslint:disable max-line-length

import * as path from 'path'
import * as minimatch from 'minimatch'
import * as _ from 'lodash'

import {
  getAllTags,
  getAllLocalCommitHashList,
  getAllTaggedCommits,
  getDiffFilesFromTagToHead,
  GitTag,
  getFileAtCommit,
  extractTag,
} from './git-utils'
import { readJson, exec, predicate, execSafe } from './common'
import { PackageJson } from './build-all-common'

export interface GetPackagePublishInfoOptions {
  readonly scope: string
  readonly packageSuffix: string
  readonly folderNames: ReadonlySet<string>
  readonly ignoreFilters?: Iterable<(element: string, indexed: number, array: readonly string[]) => boolean>,
  readonly excludeCurrent?: boolean
}

export async function getPackagePublishInfo(options: GetPackagePublishInfoOptions) {
  const { scope, excludeCurrent, packageSuffix } = options
  const packageNames = new Set(options.folderNames)
  const ignoreFilters = new Set(options.ignoreFilters || [])

  // 创建所有原始包名与后缀包名到目录名的映射
  const suffixPackageNameToOriginalMap = new Map<string, string>()
  for (const packageName of packageNames) {
    suffixPackageNameToOriginalMap.set(packageName + packageSuffix, packageName)
  }

  // 读取当前分支所有commit列表, 寻找所有分支的所有tag
  const [localCommitHashList, taggedCommitList, tagNames] = await Promise.all([
    getAllLocalCommitHashList(),
    getAllTaggedCommits(scope),
    getAllTags(),
  ])
  const taggedCommitMap = new Map(taggedCommitList.map(commit => [commit.hash, commit]))
  const allTags = tagNames.map(tagName => extractTag(tagName, scope)).filter(predicate)

  // 从所有tag中读取出已存在的包
  // 包名皆为原始名
  const existedPackageNames = new Set<string>()

  const currentTaggedCommit = taggedCommitMap.get(localCommitHashList[0])
  const currentCommitTags = new Map(currentTaggedCommit ? currentTaggedCommit.tags.map(x => [x.packageName, x.version]) : [])

  for (const tag of allTags) {
    // 如果排除当前commit, 还要排除掉当前tags
    if (excludeCurrent && currentCommitTags.get(tag.packageName) === tag.version) {
      continue
    }
    const fullPackageName = tag.packageName
    if (packageNames.has(fullPackageName)) {
      existedPackageNames.add(fullPackageName)
    } else {
      const originalPackageName = suffixPackageNameToOriginalMap.get(fullPackageName)
      if (originalPackageName && packageNames.has(originalPackageName)) {
        existedPackageNames.add(originalPackageName)
      }
    }
    if (existedPackageNames.size >= packageNames.size) break
  }

  // 计算新包
  const newPackageNames = new Set<string>()
  for (const packageName of packageNames) {
    if (existedPackageNames.has(packageName)) continue
    newPackageNames.add(packageName)
  }

  // 寻找上次发布的所有tag
  // 映射 originalPackageName => tag
  const lastPackageCommit = new Map<string, GitTag & { hash: string, index: number }>()
  {
    let index = excludeCurrent ? 1 : 0
    for (; index < localCommitHashList.length; index++) {
      const commitHash = localCommitHashList[index]
      const commit = taggedCommitMap.get(commitHash)
      if (!commit) continue
      for (const ref of commit.tags) {
        const packageName = suffixPackageNameToOriginalMap.get(ref.packageName) || ref.packageName
        if (!existedPackageNames.has(packageName)) continue
        if (lastPackageCommit.has(packageName)) continue
        lastPackageCommit.set(packageName, { ...ref, hash: commit.hash, index })
      }
      if (lastPackageCommit.size >= existedPackageNames.size) break
    }
  }

  // 计算以前发过的包里有更新的
  // 映射 originalPackageName => diffs
  const diffsSinceLastCommit = new Map<string, string[]>()

  await Promise.all(Array.from(lastPackageCommit).map(async ([folderName, info]) => {
    const allDiffs = await getDiffFilesFromTagToHead(`${scope}/${info.packageName}@${info.version}`)
    const pathPrefix = `packages/${folderName}/`
    const diffsInPackage = allDiffs.filter(filePath => filePath.indexOf(pathPrefix) === 0)
    if (!diffsInPackage.length) return
    // 用 lerna 发布配置过滤 diffs
    let diffs = diffsInPackage
    for (const filter of ignoreFilters) {
      diffs = diffs.filter(filter)
    }
    if (!diffs.length) return
    diffsSinceLastCommit.set(folderName, diffs)
  }))

  return {
    allTags,
    newPackageNames,
    existedPackageNames,
    suffixPackageNameToOriginalMap,
    diffsSinceLastCommit,
    lastPackageCommit,
    localCommitHashList,
    taggedCommitMap,
  }
}

export async function getLernaPublishInfo() {
  // 读取 lerna 发布配置
  const publishConfig = await getLernaPublishConfig()
  const ignorePatterns = publishConfig && publishConfig.ignoreChanges || []
  const message = publishConfig && publishConfig.message

  const ignoreFilters = new Set(
    ignorePatterns.map(p =>
      minimatch.filter(`!${p}`, {
        matchBase: true,
        // dotfiles inside ignored directories should also match
        dot: true,
      })
    )
  )

  return { message, ignoreFilters }
}

export interface LernaPublishConfig {
  readonly ignoreChanges?: readonly string[]
  readonly message?: string
}

export async function getLernaPublishConfig(): Promise<LernaPublishConfig | undefined> {
  return _.get(await readJson(path.resolve(process.cwd(), 'lerna.json')), ['command', 'publish'])
}

export async function getPackageJsonAtCommit(commitHash: string, packageName: string) {
  const text = await getFileAtCommit(commitHash, path.join(`packages`, packageName, `package.json`))
  return JSON.parse(text) as PackageJson
}

/**
 * 从 npm version 获取已发布的版本列表
 * - 需要高级权限
 * @param packageName 完整的包名
 */
export async function getPackageNpmVersions(packageName: string) {
  try {
    const text = await exec(`npm view ${packageName} versions`, { silent: true })
    const json: string[] = JSON.parse(text.replace(/'/g, '"').trim())
    return json
  } catch (error) {
    if (typeof error === 'string' && error.includes('404 Not Found')) {
      return []
    } else {
      throw error
    }
  }
}

type YarnPackageInfoOutput<T> = (
  | YarnPackageInfoSuccessOutput<T>
  | YarnPackageInfoErrorOutput
)

interface YarnPackageInfoSuccessOutput<T> {
  type: 'inspect'
  data: T
}

interface YarnPackageInfoErrorOutput {
  type: 'error'
  data: string
}

export interface YarnPackageInfoResult extends PackageJson {
  versions: string[]
}

/**
 * 从 npm version 获取已发布的版本列表
 * @param packageName 完整的包名
 */
export async function getPackageYarnInfo(packageName: string): Promise<YarnPackageInfoResult>
export async function getPackageYarnInfo<K extends keyof YarnPackageInfoResult>(packageName: string, field: K): Promise<YarnPackageInfoResult[K]>
export async function getPackageYarnInfo<K extends keyof YarnPackageInfoResult>(packageName: string, field?: K) {
  const { code, stdout, stderr } = await execSafe(`yarn info ${packageName} --json ${field || ''}`, { silent: true }).promise
  if (code !== 0) throw stderr
  const text = stderr || stdout
  try {
    const json: YarnPackageInfoOutput<YarnPackageInfoResult | ValuesOf<YarnPackageInfoResult>> = JSON.parse(text.trim())
    if (json.type === 'inspect') return json.data
    return []
  } catch (e) {
    console.log({ cmd: `yarn info ${packageName} --json ${field || ''}`, text })
    throw e
  }
}

type ValuesOf<T> = T[keyof T]
