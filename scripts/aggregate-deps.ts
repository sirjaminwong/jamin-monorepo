import * as fs from 'fs'
import * as path from 'path'
import * as readdir from 'readdir-enhanced'

export interface AggregateDepsOptions {
  readonly sourceFullPathList: readonly string[]
  readonly filter?: (fullPath: string) => unknown
}

const REGEXP_FROM = /from '([^./\\].*?)'/
const REGEXP_FROM_GLOBAL = new RegExp(REGEXP_FROM, 'g')

export async function aggregateDeps(options: AggregateDepsOptions) {
  const { sourceFullPathList } = options
  const filter = options.filter || defaultFilterFn

  const deps = new Set<string>()

  await Promise.all(sourceFullPathList.map(async sourceFullPath => {
    const files = await readdir.async(sourceFullPath, {
      deep: true,
      filter: (stats) => Boolean(stats.isFile() && filter(stats.path)),
    })
    await Promise.all(files.map(async file => {
      const fullPath = path.join(sourceFullPath, file)
      const buffer = await fs.promises.readFile(fullPath)
      const code = buffer.toString('utf8')
      const matches = code.match(REGEXP_FROM_GLOBAL)
      if (!matches || !matches.length) return
      for (const str of matches) {
        const match = str.match(REGEXP_FROM)!
        deps.add(match[1])
      }
    }))
  }))

  return deps
}

function defaultFilterFn(fullPath: string) {
  return fullPath.match(/\.(tsx?|jsx?)$/)
}
