// tslint:disable no-console max-line-length no-nested-template-literals cognitive-complexity trailing-comma arrow-parens only-arrow-functions no-big-function no-empty-interface

// 本脚本用于根据包之间依赖关系按照拓扑排序build各个包

import * as fs from 'fs'
import * as readdir from 'readdir-enhanced'
import * as path from 'path'
import chalk from 'chalk'
import * as yargs from 'yargs'
import { intersection, difference } from 'lodash'

import {
  run,
  exists,
  execSafe,
  mkdirp,
} from './common'
import {
  readPackageJson,
  packagesFullPath,
  scope,
} from './build-all-common'

interface Arguments {
  readonly except?: ReadonlyArray<unknown>
  readonly only?: ReadonlyArray<unknown>
}

export const DEFAULT_CONCURRENCY = 2

if (require.main === module) {
  const argv: yargs.Arguments & Arguments = (
    yargs
    .strict()
    .help('h')
    .alias('h', 'help')
    .alias('e', 'except')
    .option('except', {
      type: 'array',
      demandOption: false,
      describe: 'packages to be ignored',
    })
    .option('only', {
      type: 'array',
      demandOption: false,
      describe: 'packages to be included',
    })
    .parse()
  )

  run(() => {
    return main({
      root: argv._[0],
      except: argv.except && argv.except.map(String),
      only: argv.only && argv.only.map(String),
    })
  })
}

export interface MainOptions {
  readonly root: string
  readonly except?: readonly string[]
  readonly only?: readonly string[]
}

export async function main(options: MainOptions) {
  const { root } = options

  if (!root || typeof root !== 'string') {
    throw new Error(`root is empty`)
  }

  const rootFullPath = path.resolve(process.cwd(), root)

  // 检查目标目录node_modules以及scope的存在性
  const nodeModulesFullPath = path.resolve(rootFullPath, 'node_modules')
  const scopeFullPath = path.resolve(nodeModulesFullPath, scope)
  {
    const stat = await exists(nodeModulesFullPath)
    if (!stat || !stat.isDirectory()) {
      throw new Error(`${JSON.stringify(root)} is not a directory (resolved to ${JSON.stringify(nodeModulesFullPath)})`)
    }
  }
  {
    const stat = await exists(scopeFullPath)
    if (!stat || !stat.isDirectory()) {
      throw new Error(`scope ${JSON.stringify(scope)} is not found in node_modules (resolved to ${JSON.stringify(scopeFullPath)})`)
    }
  }

  const except = options.except || []

  const [
    packageNames,
    targetPackageNames,
  ] = await Promise.all([
    packagesFullPath,
    scopeFullPath,
  ].map(async fullPath => {
    let result = await fs.promises.readdir(fullPath)
    result = result.filter(x => !x.match(/^\./))
    if (options.only) {
      const { only } = options
      result = result.filter(x => only.includes(x))
    }
    result = result.filter(x => except.every(ignored => x.indexOf(ignored) < 0))
    return result
  }))

  const commonPackageNames = intersection(packageNames, targetPackageNames)

  if (!commonPackageNames.length) return

  await Promise.all(commonPackageNames.map(async (packageName) => {
    const packageFullPath = path.join(packagesFullPath, packageName)
    const packageJsonPath = path.join(packageFullPath, 'package.json')
    if (!await exists(packageJsonPath)) {
      return console.log(`file ${JSON.stringify(`packages/${packageName}/package.json`)} is not found, skipped`)
    }

    const targetPackageFullPath = path.join(scopeFullPath, packageName)
    const [
      sourceFileNames,
      targetFileNames,
    ] = await Promise.all([
      packageFullPath,
      targetPackageFullPath,
    ].map(fullPath => fs.promises.readdir(fullPath)))

    const commonFileNames = intersection(sourceFileNames, targetFileNames)

    const { files } = readPackageJson(require(packageJsonPath))

    const pickedFiles = Array.from(files).map(file => {
      const fileFullPath = path.resolve(packageFullPath, file)
      const pos = fileFullPath.indexOf(packageFullPath)
      if (pos !== 0) return ''
      return fileFullPath.slice(packageFullPath.length + 1).split(path.sep)[0] || ''
    }).filter(Boolean)

    const unionFiles = new Set([...pickedFiles, ...commonFileNames])
    unionFiles.delete('node_modules')

    await Promise.all(Array.from(unionFiles).map(async fileName => {
      const sourceFullPath = path.join(packageFullPath, fileName)
      const targetFullPath = path.join(targetPackageFullPath, fileName)
      const targetStat = await exists(targetFullPath)
      if (targetStat && targetStat.isFile()) {
        const [sourceFileBuffer, targetFileBuffer] = await Promise.all([
          fs.promises.readFile(sourceFullPath),
          fs.promises.readFile(targetFullPath),
        ])
        if (sourceFileBuffer.equals(targetFileBuffer)) return
        await fs.promises.copyFile(
          sourceFullPath,
          targetFullPath,
          fs.constants.COPYFILE_FICLONE,
        )
        if (fileName === 'package.json') {
          console.log(chalk.cyan(`${packageName}/package.json has changed`))
        }
      } else {
        if (await exists(sourceFullPath)) {
          const [sourceFiles, targetFiles] = await Promise.all([
            sourceFullPath,
            targetFullPath,
          ].map(async fileFullPath => {
            if (await exists(fileFullPath)) {
              return readdir.async(fileFullPath, { deep: true, filter: (stats) => stats.isFile() })
            }
            return []
          }))
          const modifiedFiles = intersection(sourceFiles, targetFiles)
          const addedFiles = difference(sourceFiles, modifiedFiles)
          const removedFiles = difference(targetFiles, sourceFiles)
          if (addedFiles.length) {
            await Promise.all(addedFiles.map(async file => {
              const sourceFileFullPath = path.join(sourceFullPath, file)
              const targetFileFullPath = path.join(targetFullPath, file)
              await mkdirp(path.dirname(targetFileFullPath))
              await fs.promises.copyFile(
                sourceFileFullPath,
                targetFileFullPath,
                fs.constants.COPYFILE_FICLONE,
              )
            }))
          }
          if (modifiedFiles.length) {
            await Promise.all(modifiedFiles.map(async file => {
              const sourceFileFullPath = path.join(sourceFullPath, file)
              const targetFileFullPath = path.join(targetFullPath, file)
              const [sourceFileBuffer, targetFileBuffer] = await Promise.all([
                fs.promises.readFile(sourceFileFullPath),
                fs.promises.readFile(targetFileFullPath),
              ])
              if (sourceFileBuffer.equals(targetFileBuffer)) return
              await fs.promises.copyFile(
                sourceFileFullPath,
                targetFileFullPath,
                fs.constants.COPYFILE_FICLONE,
              )
            }))
          }
          if (removedFiles.length) {
            await Promise.all(removedFiles.map(async file => {
              const targetFileFullPath = path.join(targetFullPath, file)
              await fs.promises.unlink(targetFileFullPath)
            }))
          }
        } else {
          const removeCommand = `rm -rf ${JSON.stringify(targetFullPath)}`
          await execSafe(removeCommand, { silent: true })
        }
      }
    }))
  }))
}
