// tslint:disable no-console max-line-length no-nested-template-literals cognitive-complexity trailing-comma arrow-parens only-arrow-functions no-big-function

// 本脚本用于根据包之间依赖关系按照拓扑排序build各个包并发布, 并且专门为 ci 设计

import * as fs from 'fs'
import * as path from 'path'
import chalk from 'chalk'
import * as semver from 'semver'
import * as yargs from 'yargs'

import {
  run,
  exists,
  ExternalPromise,
  createExternalPromise,
  Concurrent,
  exec,
} from './common'
import {
  readPackageJson,
  resolveTopologicalSorting,
  packagesFullPath,
  StringStringMap,
  scope,
  PackageJson,
  collectPackagesToBuild,
  resolveRelevantChanges,
} from './build-all-common'
import {
  getPackagePublishInfo,
  getLernaPublishInfo,
  getPackageYarnInfo,
} from './release-common'
import { getReleaseBranchInfo, toPackageShiftedName, injectSuffixToPackageJson } from './release-branch'

export const DEFAULT_CONCURRENCY = 5

const ignoreLintList: ReadonlySet<string> = new Set([
  'aid',
  'collage-adapter',
  'collage-editor',
  'collage-manual-editor',
  'collage-engine',
  'core-data-access-layer',
  'dal-renderer-canvas',
  'dal-renderer-interface',
  'dal-renderer-react',
  'domain-model',
  'file-helper',
  'font',
  'gallery',
  'generic-data-access-layer',
  'layout-core',
  'matting-editor',
  'storage',
  'shadow-editor',
  'text-layout-adapter',
  'text-style-editor',
  'ts-transformers',
  'ts-schema',
  'visual-editor',
])

interface Arguments {
  readonly concurrent?: number
  readonly dryRun?: boolean
}

if (require.main === module) {
  const argv: yargs.Arguments & Arguments = (
    yargs
    .strict()
    .parserConfiguration({ 'boolean-negation': false })
    .alias('c', 'concurrent')
    .option('concurrent', {
      type: 'number',
      nargs: 1,
      demandOption: false,
      describe: 'How many builds are allowed to run simultaneously. Non-positive value will be treated as Infinity',
    })
    .option('dry-run', {
      type: 'boolean',
      nargs: 0,
      demandOption: false,
      describe: 'Act like publish but will not push to server',
    })
    .help('h')
    .alias('h', 'help')
    .parse()
  )

  const { publish, packageSuffix } = getReleaseBranchInfo()

  const { concurrent, dryRun } = argv

  run(() => main({ publish, concurrent, dry: dryRun, suffix: packageSuffix }))
}

export interface MainOptions {
  readonly suffix: string
  readonly publish: boolean
  readonly dry?: boolean
  readonly concurrent?: number
}

export async function main(options: MainOptions) {
  // 读取 lerna 发布配置
  const lerna = await getLernaPublishInfo()

  const shouldPublish = options.publish

  const isDryRun = Boolean(options.dry)

  // 并发数
  const concurrency = formatConcurrency(options.concurrent)

  // 包名后缀
  const packageNameSuffix = options.suffix

  console.log(
    chalk.bgBlack(
      chalk.whiteBright(
        JSON.stringify({
          publish: shouldPublish,
          dryRun: isDryRun,
          suffix: packageNameSuffix,
          concurrency,
        }, null, 2)
      )
    )
  )

  const packageFolderNames = await getPackageFolderNames()

  // packageJsonMap => Map<packageName, package.json>
  const packageJsonMap = new Map<string, PackageJson>()
  // packageDeps => Map<packageName, depPackageNameSet>
  const packageDeps = new Map<string, Set<string>>()
  // packageScripts => Map<packageName, scriptMap>
  const packageScripts = new Map<string, StringStringMap>()

  await Promise.all(Array.from(packageFolderNames).map(async (folderName) => {
    // 读取修改前的 package.json
    const packageJson = await getPackageJson(folderName)
    const { deps, scripts } = readPackageJson(packageJson)
    packageJsonMap.set(folderName, packageJson)
    packageDeps.set(folderName, deps)
    packageScripts.set(folderName, scripts)
  }))

  if (!packageDeps.size) return

  // 获取所有包的拓扑结构
  const topologicalSortingOfAll: readonly string[] = Array.from(resolveTopologicalSorting(packageDeps))

  // 改变的包, 下面会进行 test 和 build 等操作
  const changedPackageNames = new Set<string>()

  // 读取发布信息
  const { newPackageNames, diffsSinceLastCommit } = await getPackagePublishInfo({
    scope,
    packageSuffix: packageNameSuffix,
    folderNames: packageFolderNames,
    ignoreFilters: lerna.ignoreFilters,
    excludeCurrent: true,
  })

  // 读取发布信息中新增或有修改的包, 写入改变的包
  for (const packageName of newPackageNames) {
    changedPackageNames.add(packageName)
  }
  for (const packageName of diffsSinceLastCommit.keys()) {
    changedPackageNames.add(packageName)
  }

  const sourcePackages = new Set(changedPackageNames)

  if (!shouldPublish) {
    // 非发布环节(即校验环节), 由于变化包可能导致其他包功能异常, 需要build并test
    const relevantPackageChanges = resolveRelevantChanges(packageDeps, changedPackageNames)
    for (const packageName of relevantPackageChanges.keys()) {
      sourcePackages.add(packageName)
    }
  }

  const packagesToBuild = collectPackagesToBuild(packageDeps, sourcePackages)

  const sortedPackagesToBuild: readonly string[] = topologicalSortingOfAll.filter(x => packagesToBuild.has(x))

  const tasks = new Tasks()

  // 制作 build 列表
  const buildMap = new Map<string, Task>()
  for (const packageName of sortedPackagesToBuild) {
    const scripts = packageScripts.get(packageName)!
    const script = getBuildCmd(scripts)
    const depNames = Array.from(packageDeps.get(packageName)!)
    buildMap.set(packageName, {
      name: `build ${packageName}`,
      cmds: !script ? [] : [
        `cd ${path.join('packages', packageName)} && yarn ${script}`,
      ],
      deps: new Set([
        // 需要所有依赖包 build 好
        ...depNames.map(depName => `build ${depName}`),
      ]),
    })
  }

  // 制作 lint 列表
  const lintMap = new Map<string, Task>()
  if (!shouldPublish) {
    for (const packageName of changedPackageNames) {
      if (ignoreLintList.has(packageName)) continue
      const scripts = packageScripts.get(packageName)!
      const script = getLintCmd(scripts)
      if (!script) continue
      const depNames = Array.from(packageDeps.get(packageName)!)
      lintMap.set(packageName, {
        name: `lint ${packageName}`,
        cmds: [
          `cd ${path.join('packages', packageName)} && yarn ${script}`,
        ],
        deps: new Set([
          // 需要所有依赖包 build 好
          ...depNames.map(depName => `build ${depName}`),
        ]),
      })
    }
  }

  // 制作 test 列表
  const testMap = new Map<string, Task>()
  if (!shouldPublish) {
    for (const packageName of sourcePackages) {
      const scripts = packageScripts.get(packageName)!
      const script = getTestCmd(scripts)
      if (!script) continue
      const buildTask = buildMap.get(packageName)
      testMap.set(packageName, {
        name: `test ${packageName}`,
        cmds: [
          `cd ${path.join('packages', packageName)} && yarn ${script}`,
        ],
        deps: new Set(buildTask ? [buildTask.name] : []),
      })
    }
  }

  const taskMap = new Map(
    [
      ...Array.from(buildMap.values()),
      ...Array.from(lintMap.values()),
      ...Array.from(testMap.values()),
    ].map(x => [x.name, x] as const)
  )

  if (!taskMap.size) return

  // 打印信息
  console.log(chalk.cyan('Tasks will be executed in following order:'))
  console.log()

  for (const task of taskMap.values()) {
    console.log(chalk.whiteBright(`  ${task.name}`))
    for (const depTaskName of task.deps) {
      const depTask = taskMap.get(depTaskName)
      if (!depTask) {
        throw new Error(`task ${depTaskName} does not exist`)
      }
      console.log(chalk.gray(`    - ${depTask.name}`))
    }
  }

  console.log()

  // 并发执行指令
  const concurrent = new Concurrent(concurrency)

  await Promise.all(
    Array.from(taskMap.values()).map(async task => {
      try {
        await Promise.all(Array.from(task.deps).map(dep => tasks.waitFor(dep)))
        await concurrent.run(async () => {
          for (const cmd of task.cmds) {
            console.log(chalk.yellow(cmd))
            await exec(cmd)
          }
        })
        tasks.resolve(task.name)
      } catch (e) {
        tasks.reject(task.name, e)
        throw e
      }
    })
  )

  if (shouldPublish) {
    // 读取需要发的包
    const packagesToPublish = await getPackagesToPublishFromNPM(changedPackageNames, packageNameSuffix)

    // 检查需要发布的包引用到的包是否曾经发过分支
    const possibleHistoryNames = new Set<string>()
    for (const folderName of packagesToPublish) {
      const deps = packageDeps.get(folderName)
      if (!deps) continue
      for (const dep of deps) {
        possibleHistoryNames.add(dep)
      }
    }
    for (const folderName of packagesToPublish) {
      possibleHistoryNames.delete(folderName)
    }
    const existedHistoryNames = await checkBranchExistanceFromNPM(possibleHistoryNames, packageNameSuffix)

    // 如果有后缀, 修改 package 信息
    if (packageNameSuffix) {
      await appendSuffixToPackages(
        packageJsonMap,
        packagesToPublish,
        existedHistoryNames,
        packageNameSuffix,
      )
    }

    // 执行发布过程
    await Promise.all(Array.from(packagesToPublish).map(async folderName => {
      const packageJson = await getPackageJson(folderName)
      console.log(chalk.whiteBright(`publishing ${packageJson.name}@${packageJson.version} to cnpm...`))
      const version = semver.parse(packageJson.version)
      const tag = version && version.prerelease.length > 0 ? version.prerelease[0] : undefined
      let publishScript = `npm publish`
      if (tag) {
        publishScript += ` --tag ${tag}`
      }
      if (isDryRun) {
        publishScript += ` --dry-run`
      }
      await exec(`cd ${path.resolve('packages', folderName)} && ${publishScript}`, { silent: true })
    }))
  }

  function getBuildCmd(scripts: StringStringMap) {
    return scripts['ci:build'] ? 'ci:build' : scripts.build ? 'build' : ''
  }

  function getLintCmd(scripts: StringStringMap) {
    return scripts['ci:lint'] ? 'ci:lint' : scripts.lint ? 'lint' : ''
  }

  function getTestCmd(scripts: StringStringMap) {
    return scripts['ci:test'] ? 'ci:test' : scripts['unit-test'] ? 'unit-test' : ''
  }
}

/**
 * 读取目录的 package.json
 * @param folderName 目录名
 */
async function getPackageJson(folderName: string): Promise<PackageJson> {
  const packageJsonPath = path.join(packagesFullPath, folderName, 'package.json')
  return JSON.parse((await fs.promises.readFile(packageJsonPath)).toString('utf8'))
}

/**
 * 读取目录的 package.json
 * @param folderName 目录名
 */
async function setPackageJson(folderName: string, packageJson: PackageJson) {
  const packageJsonPath = path.join(packagesFullPath, folderName, 'package.json')
  return fs.promises.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2))
}

/**
 * 格式化并发数
 * @param input 输入参数
 */
function formatConcurrency(input: unknown) {
  const value = Math.floor(Number(input))
  return Number.isNaN(value) ? DEFAULT_CONCURRENCY : value > 0 ? value : Infinity
}

/**
 * 读取含 package.json 的目录
 */
async function getPackageFolderNames() {
  // 读取 packages 下所有文件和目录
  const fileNames = (
    (await fs.promises.readdir(packagesFullPath))
    .filter(x => !x.match(/^\./))
  )

  const folderNames = new Set<string>()

  // 过滤出带有 package.json 的目录
  await Promise.all(fileNames.map(async (fileName) => {
    const packageDirName = path.join(packagesFullPath, fileName)
    const stat = await fs.promises.stat(packageDirName)
    if (!stat.isDirectory()) return
    const packageJsonPath = path.join(packageDirName, 'package.json')
    if (!await exists(packageJsonPath)) {
      return console.log(`file ${JSON.stringify(`packages/${fileName}/package.json`)} is not found, skipped`)
    }
    folderNames.add(fileName)
  }))

  return folderNames
}

/**
 * 从 npm version 获取要发布的包名集合
 * - 查询的时候带后缀
 * - 返回的包名不带后缀
 * @param folderNames
 */
async function getPackagesToPublishFromNPM(folderNames: Iterable<string>, suffix: string) {
  const packagesToPublish = new Set<string>()

  await Promise.all(
    Array.from(new Set(folderNames)).map(async (folderName) => {
      const packageJson = await getPackageJson(folderName)

      // 跳过私有包
      if (packageJson.private) return

      const branchPackageName = toPackageShiftedName(folderName, suffix)

      const versions = await getPackageYarnInfo(branchPackageName, 'versions')
      if (!versions.includes(packageJson.version)) {
        packagesToPublish.add(folderName)
      }
    })
  )

  return packagesToPublish
}

/**
 * 从 npm version 获取包名集合的版本列表
 * - 查询的时候带后缀
 * - 返回的包名不带后缀
 * @param folderNames
 */
async function checkBranchExistanceFromNPM(folderNames: Iterable<string>, suffix: string) {
  const existedPackages = new Set<string>()

  await Promise.all(
    Array.from(new Set(folderNames)).map(async (folderName) => {
      const branchPackageName = toPackageShiftedName(folderName, suffix)
      const versions = await getPackageYarnInfo(branchPackageName, 'versions')
      if (versions.length > 0) {
        existedPackages.add(folderName)
      }
    })
  )

  return existedPackages
}

interface Task {
  readonly name: string
  readonly cmds: readonly string[]
  readonly deps: ReadonlySet<string>
}

class Tasks {
  private _tasks = new Map<string, ExternalPromise<void>>()

  waitFor(taskName: string) {
    return this._getExternalPromise(taskName).promise
  }

  resolve(taskName: string) {
    this._getExternalPromise(taskName).resolve()
  }

  reject(taskName: string, error: unknown) {
    this._getExternalPromise(taskName).reject(error)
  }

  private _getExternalPromise(taskName: string) {
    let xp = this._tasks.get(taskName)
    if (xp) return xp
    this._tasks.set(taskName, xp = createExternalPromise())
    return xp
  }
}

async function appendSuffixToPackages(
  packageJsonMap: ReadonlyMap<string, Readonly<PackageJson>>,
  folderNamesToAlter: Iterable<string>,
  historyNames: Iterable<string>,
  suffix: string,
) {
  const folderNames = new Set(folderNamesToAlter)
  const aliasNames = new Set([...Array.from(folderNames), ...Array.from(historyNames)])
  const newPackageNames = new Map(Array.from(aliasNames).map(folderName =>
    [folderName, folderName + suffix],
  ))
  await Promise.all(
    Array.from(folderNames).map(async (folderName) => {
      const packageJson = injectSuffixToPackageJson(
        await getPackageJson(folderName),
        folderName,
        newPackageNames,
        packageJsonMap,
      )

      await setPackageJson(folderName, packageJson)
    })
  )
}
