// tslint:disable no-console max-line-length
import * as os from 'os'

import { exec, predicate } from './common'

export class Status {
  readonly map: ReadonlyMap<string, StatusOutput>

  constructor(readonly status: readonly StatusOutput[]) {
    this.map = new Map(status.map(x => [x.path, x]))
  }

  * changes(input: readonly StatusOutput[]) {
    const { map } = this
    for (const item of input) {
      if (map.has(item.path)) continue
      yield item
    }
  }
}

export async function getStatusOutput() {
  return formatStatusOutput(await exec('git status -s', { silent: true }))
}

export async function getHeadFile(fullPath: string) {
  return exec(`git show HEAD:${JSON.stringify(fullPath)}`, { silent: true })
}

export type StatusOutput = ReturnType<typeof formatStatusOutput>[number]

function formatStatusOutput(output: string) {
  return (
    output
    .split('\n')
    .filter(Boolean)
    .map(x => ({
      line: x,
      match: x.match(/^ *?([^ ]+?) (.*?)$/)!,
    } as const))
    .map(x => ({
      line: x,
      type: x.match[1],
      path: x.match[2],
    } as const))
  )
}

/**
 * 获取所有 tags
 * - 顺序不保证
 */
export async function getAllTags() {
  const stdout = await exec(`git tag -l`, { silent: true })
  return stdout.split(os.EOL).filter(Boolean)
}

export interface GitTag {
  packageName: string
  version: string
}

export interface GitCommit {
  hash: string
  tags: GitTag[]
}

/**
 * 读取所有带标签的 commit
 * @param scope 标签的 scope
 */
export async function getAllTaggedCommits(scope?: string) {
  const result = await exec(`git log --no-walk --tags --pretty="%H %d"`, { silent: true })
  const list: GitCommit[] = []
  for (const line of result.split(os.EOL)) {
    if (!line) continue
    const match = line.match(/^([a-z0-9]+?) +?\((.*?)\)$/i)
    if (!match || !match[1] || !match[2]) {
      continue
    }
    const hash = match[1]
    const tags = (
      match[2]
      .split(', ')
      .map(x => x.match(/^tag: (.*?)$/i))
      .filter(predicate)
      .map(x => x[1])
      .map(str => extractTag(str, scope))
      .filter(predicate)
    )
    list.push({ hash, tags })
  }
  return list
}

export function extractTag(str: string, scope?: string): GitTag | undefined {
  const exp = `${scope ? scope + '/' : ''}(.+?)@([a-z0-9-\\.]+?)$`
  const match = str.match(new RegExp(exp, 'i'))
  if (match && match[1] && match[2]) {
    return {
      packageName: match[1],
      version: match[2],
    }
  }
  return undefined
}

export async function getAllLocalCommitHashList() {
  const result = await exec(`git log --pretty=format:"%H"`, { silent: true })
  return result.split(os.EOL).filter(Boolean)
}

export async function getDiffFilesFromTagToHead(tag: string) {
  const result = await exec(`git diff --name-only ${tag}..HEAD`, { silent: true })
  return result.split(os.EOL).filter(predicate)
}

export function getFileAtCommit(commitHash: string, relativeFilePath: string) {
  return exec(`git show ${commitHash}:${relativeFilePath}`, { silent: true })
}

export async function getCurrentBranchName() {
  return (await exec(`git rev-parse --abbrev-ref HEAD`, { silent: true })).split(os.EOL).filter(predicate)[0] || ''
}
