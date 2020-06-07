// tslint:disable no-console max-line-length no-nested-template-literals cognitive-complexity trailing-comma arrow-parens

// 本脚本用于根据包之间依赖关系按照拓扑排序build各个包

import * as fs from 'fs'
import * as path from 'path'
import * as minimatch from 'minimatch'

import { exists, hashFolder, mkdirp, hashFile } from './common'

export const scope = '@arkie'

export const packagesFullPath = path.join(process.cwd(), 'packages')

export const cacheFullPath = path.join(__dirname, 'build-all-cache')

export const POSSIBLE_SOURCE_FOLDER_NAME = [
  'src',
  'components',
] as const

// @see https://docs.npmjs.com/files/package.json
export const ALLWAYS_IGNORED_GLOBS = [
  '.git',
  'CVS',
  '.svn',
  '.hg',
  '.lock-wscript',
  '.wafpickle-N',
  '.*.swp',
  '.DS_Store',
  '._*',
  'npm-debug.log',
  '.npmrc',
  'node_modules',
  'config.gypi',
  '*.orig',
]

const matchIgnoredBlobs = ALLWAYS_IGNORED_GLOBS.map(p =>
  new minimatch.Minimatch(p, {
    matchBase: true,
    // dotfiles inside ignored directories should also match
    dot: true,
  })
)

export async function updatePackageCache(packageName: string) {
  const ret = await readPackageCache(packageName)
  if (ret) {
    await mkdirp(cacheFullPath)
    const cacheJsonPath = path.join(cacheFullPath, `${packageName}.json`)
    await writeCache(cacheJsonPath, {
      srcMd5: ret.srcHash,
      filesMd5: ret.buildHash,
      packageJsonMd5: ret.packageJsonHash,
    })
    return true
  } else {
    return false
  }
}

export function createNpmFilesMatcher(files: Iterable<string>) {
  const list = Array.from(new Set(files))
  if (!list.length) list.push('*')
  const matchers = list.map(p =>
    new minimatch.Minimatch(p, {
      matchBase: true,
      // dotfiles inside ignored directories should also match
      dot: true,
    })
  )
  return function match(filePath: string) {
    for (const ignorer of matchIgnoredBlobs) {
      if (ignorer.match(filePath)) return false
    }
    for (const matcher of matchers) {
      if (matcher.match(filePath)) return true
    }
    return null
  }
}

export async function readPackageCache(packageName: string) {
  const packageDirName = path.join(packagesFullPath, packageName)
  const packageJsonPath = path.join(packageDirName, 'package.json')

  const { files } = readPackageJson(JSON.parse((await fs.promises.readFile(packageJsonPath)).toString('utf8')))

  if (!files.size) {
    console.log(`No files found in ${packageJsonPath}, using all files`)
    // @see https://docs.npmjs.com/files/package.json
    files.add('*')
  }

  let packageSourceName: string | undefined
  for (const srcName of POSSIBLE_SOURCE_FOLDER_NAME) {
    const fullPath = path.join(packageDirName, srcName)
    if (await exists(fullPath)) {
      packageSourceName = fullPath
      break
    }
  }
  if (!packageSourceName) return

  const matcher = createNpmFilesMatcher(files)

  await mkdirp(cacheFullPath)

  const cacheFileName = path.join(cacheFullPath, `${packageName}.json`)
  const cache = readCache(cacheFileName)

  const filter = (fullPath: string) => {
    if (fullPath.indexOf(packageDirName) !== 0) return false
    const p = fullPath.slice(packageDirName.length)
    if (p === '/package.json') return false
    return matcher(p)
  }

  const [srcHash, buildHash, packageJsonHash] = await Promise.all([
    (async () => {
      return (await hashFolder(packageSourceName)).hash
    })(),
    (async () => {
      return (await hashFolder(packageDirName, undefined, filter)).hash
    })(),
    hashFile(packageJsonPath),
  ])

  return { cache, srcHash, buildHash, packageJsonHash }
}

export const dependencyKeys = ['dependencies', 'devDependencies', 'peerDependencies'] as const

export function readPackageJson(json: PackageJson) {
  const deps = new Set(
    Object.keys({
      ...json.dependencies,
      ...json.devDependencies,
      ...json.peerDependencies,
    })
    .filter((x) => x.indexOf(scope) === 0)
    .map((x) => x.slice(scope.length + 1))
  )
  return { deps, files: new Set(json.files), scripts: json.scripts || {} }
}

export function resolveTopologicalSorting(map: ReadonlyMap<string, ReadonlySet<string>>) {
  return resolveTopologicalSortingInternal(clonePackageDeps(map))
}

function * resolveTopologicalSortingInternal(map: Map<string, Set<string>>) {
  while (map.size) {
    const yielded = new Set<string>()
    for (const [packageName, deps] of map) {
      if (deps.size) continue
      yielded.add(packageName)
      yield packageName
    }
    for (const [packageName, deps] of map) {
      if (yielded.has(packageName)) {
        map.delete(packageName)
      } else {
        for (const item of yielded) {
          deps.delete(item)
        }
      }
    }
  }
}

/**
 * 收集需要构建的包
 * @param packageNameToDepPackageNameMap
 * @param packagesToBuild
 */
export function collectPackagesToBuild(
  packageNameToDepPackageNameMap: ReadonlyMap<string, ReadonlySet<string>>,
  packagesToBuild: ReadonlySet<string>,
): Set<string> {
  const result = new Set<string>()
  collectPackagesToBuildInternal(result, packageNameToDepPackageNameMap, packagesToBuild)
  return result
}

function collectPackagesToBuildInternal(
  result: Set<string>,
  depsMap: ReadonlyMap<string, ReadonlySet<string>>,
  packageNames: ReadonlySet<string>,
): void {
  for (const packageName of packageNames) {
    if (result.has(packageName)) continue
    result.add(packageName)
    const deps = depsMap.get(packageName)!
    collectPackagesToBuildInternal(result, depsMap, deps)
  }
}

export function resolveRelevantChanges(
  map: ReadonlyMap<string, ReadonlySet<string>>,
  picks: ReadonlySet<string>,
) {
  const revMap = new Map<string, Set<string>>()
  for (const [packageName, deps] of map) {
    for (const dep of deps) {
      let set = revMap.get(dep)
      if (!set) revMap.set(dep, set = new Set())
      set.add(packageName)
    }
  }
  const picked = new Map<string, Set<string>>()
  for (const packageName of picks) {
    pickPackageDeps(map, revMap, packageName, picked)
  }
  const pickedKeys = new Set(picked.keys())
  for (const deps of picked.values()) {
    for (const dep of deps) {
      if (pickedKeys.has(dep)) continue
      deps.delete(dep)
    }
  }
  return picked
}

function pickPackageDeps(
  map: ReadonlyMap<string, ReadonlySet<string>>,
  revMap: ReadonlyMap<string, ReadonlySet<string>>,
  packageName: string,
  picked: Map<string, Set<string>>,
): void {
  if (picked.has(packageName)) return
  const deps = map.get(packageName)
  if (!deps) return
  picked.set(packageName, new Set(deps))
  const influencing = revMap.get(packageName)
  if (!influencing) return
  for (const influenced of influencing) {
    pickPackageDeps(map, revMap, influenced, picked)
  }
}

export function clonePackageDeps(map: ReadonlyMap<string, ReadonlySet<string>>) {
  return new Map(Array.from(map.entries()).map((entry) => [entry[0], new Set(Array.from(entry[1]))] as const))
}

export function readCache(fullPath: string): Cache {
  try {
    const obj = require(fullPath)
    return obj && typeof obj === 'object' ? { ...obj } : {}
  } catch (e) {
    return {}
  }
}

export function writeCache(fullPath: string, cache: Required<Cache>) {
  return fs.promises.writeFile(fullPath, JSON.stringify(cache, null, 2))
}

/**
 * 读取目录的 package.json
 * @param filePath 文件路径
 */
export async function getPackageJson(filePath: string): Promise<PackageJson> {
  return JSON.parse((await fs.promises.readFile(filePath)).toString('utf8'))
}

/**
 * 写入目录的 package.json
 * @param filePath 文件路径
 * @param packageJson
 */
export async function setPackageJson(filePath: string, packageJson: PackageJson) {
  return fs.promises.writeFile(filePath, JSON.stringify(packageJson, null, 2))
}

export interface PackageJson {
  version: string
  name: string
  private?: boolean
  files?: string[]
  scripts?: StringStringMap
  dependencies?: StringStringMap
  devDependencies?: StringStringMap
  peerDependencies?: StringStringMap
}

export interface StringStringMap {
  [key: string]: string
}

export interface Cache {
  srcMd5?: string
  filesMd5?: string
  packageJsonMd5?: string
}
