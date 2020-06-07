import * as path from 'path'
import * as ts from 'typescript'
import * as yargs from 'yargs'
import { times } from 'lodash'

import { run, exec, execSafe } from './common'
import { readTsConfigFile } from './tsconfig-utils'

const TEMP_DIR_NAME = 'tmp'

interface Arguments {
  readonly dry?: boolean
  readonly verbose?: boolean
}

if (require.main === module) {
  const argv: yargs.Arguments & Arguments = (
    yargs
    .strict()
    .option('dry', {
      type: 'boolean',
      nargs: 0,
      demandOption: false,
      describe: 'dry run',
    })
    .option('verbose', {
      type: 'boolean',
      nargs: 0,
      demandOption: false,
      describe: 'verbose',
    })
    .help('h')
    .alias('h', 'help')
    .parse()
  )

  const tsconfigList = argv._
  const { dry, verbose } = argv

  run(() => main({
    tsconfigList,
    dry,
    verbose,
  }))
}

export interface MainOptions {
  readonly tsconfigList: readonly string[]
  readonly dry?: boolean
  readonly verbose?: boolean
  readonly beforeBuild?: () => unknown
  readonly onBuild?: () => unknown
  readonly afterBuild?: (data: ReadonlyDeep<Extract<ReturnType<typeof getCommands>, {}>>) => unknown
}

export async function main(options: MainOptions) {
  const ret = getCommands(options.tsconfigList)
  if (!ret) {
    throw new Error(`No tsconfig input is provided`)
  }
  const {
    removeCommand,
    buildCommands,
    cleanupCommands,
    finalCleanupCommand,
  } = ret

  const dry = Boolean(options.dry)
  const verbose = Boolean(options.verbose)

  if (verbose) {
    console.log('The following commands will be executed')
    console.log()
    console.log(`  ${removeCommand}`)
    for (const command of buildCommands) {
      console.log(`  ${command}`)
    }
    for (const command of cleanupCommands) {
      console.log(`  ${command}`)
    }
    console.log(`  ${finalCleanupCommand}`)
    console.log()
  }

  if (dry) return

  await exec(removeCommand)
  try {
    if (typeof options.beforeBuild === 'function') {
      await options.beforeBuild()
    }
    await Promise.all([
      typeof options.onBuild === 'function' ? options.onBuild() : undefined,
      Promise.all(buildCommands.map(command => exec(command))),
    ])
    if (typeof options.afterBuild === 'function') {
      await options.afterBuild(ret)
    }
    await Promise.all(cleanupCommands.map(command => execSafe(command).promise))
  } finally {
    await execSafe(finalCleanupCommand).promise
  }
}

export function getCommands(list: readonly string[]) {
  const tsconfigFullPathList = list.map(fullPath => path.resolve(process.cwd(), fullPath))
  if (!tsconfigFullPathList.length) return

  const tsconfigList = tsconfigFullPathList.map(fullPath => ensureOutDir(readTsConfigFile(fullPath), fullPath))
  const tmpDir = getTempDirPrefix(tsconfigList.map(x => x.outDir))
  const tmpFullPath = path.relative(process.cwd(), tmpDir)

  const removeCommand = `rm -rf ${JSON.stringify(tmpFullPath)}`

  const buildCommands = times(tsconfigList.length, i => {
    const compiler = resolveDefaultCompiler(tsconfigList[i])
    const relativePath = path.relative(process.cwd(), tsconfigFullPathList[i])
    return `${compiler} --pretty -p ${relativePath}`
  })

  const targets = times(tsconfigList.length, i => {
    const { outDir } = tsconfigList[i]
    const sourcePath = path.relative(process.cwd(), outDir)
    const targetPath = path.relative(process.cwd(), outDir.slice(tmpDir.length + 1))
    return { sourcePath, targetPath }
  })

  const cleanupCommands = targets.map(item => {
    const { sourcePath, targetPath } = item
    return `rm -rf ${targetPath} && mv ${sourcePath} ${targetPath}`
  })

  const finalCleanupCommand = removeCommand

  return {
    tmpDir,
    tmpFullPath,
    targets,
    removeCommand,
    buildCommands,
    cleanupCommands,
    finalCleanupCommand,
    tsconfigFullPathList,
  }
}

function getTempDirPrefix(outputDirList: string[]) {
  if (!outputDirList.length) return ''
  const firstItem = outputDirList[0]
  const locator = `/${TEMP_DIR_NAME}/`
  const tmpPos = firstItem.indexOf(locator)
  if (tmpPos < 0) {
    throw new Error(`No "${locator}" found in ${JSON.stringify(firstItem)}`)
  }
  const prefix = firstItem.slice(0, tmpPos + locator.length)
  for (let i = 1; i < outputDirList.length; i++) {
    if (outputDirList[i].slice(0, prefix.length) !== prefix) {
      throw new Error(`Path ${JSON.stringify(outputDirList[i])} doesn't match prefix ${JSON.stringify(prefix)}`)
    }
  }
  return prefix.slice(0, -1)
}

function ensureOutDir(config: ts.CompilerOptions, fileName: string): ts.CompilerOptions & { outDir: string } {
  if (typeof config.outDir !== 'string') {
    throw new Error(`"outDir" doesn't exist in tsconfig file ${JSON.stringify(fileName)}`)
  }
  return {
    ...config,
    outDir: config.outDir
  }
}

function resolveDefaultCompiler(tsconfig: ts.CompilerOptions) {
  const { plugins } = tsconfig
  if (Array.isArray(plugins)) {
    for (const plugin of plugins) {
      if (plugin && typeof plugin === 'object' && 'transform' in plugin) {
        return 'ttsc'
      }
    }
  }
  return 'tsc'
}

/** Object types that should never be mapped */
type AtomicObject =
  | Function
  | Map<any, any>
  | WeakMap<any, any>
  | Set<any>
  | WeakSet<any>
  | Promise<any>
  | Date
  | RegExp
  | boolean
  | number
  | string

type ReadonlyDeep<T> = (
  T extends AtomicObject ? T :
  T extends object ? {readonly [K in keyof T]: ReadonlyDeep<T[K]>} :
  T
)
