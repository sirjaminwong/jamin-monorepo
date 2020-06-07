// tslint:disable max-line-length no-big-function

import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import chalk from 'chalk'
import * as _ from 'lodash'
import * as semver from 'semver'
import * as yargs from 'yargs'

import { run, exec, createStringError, getDirectories, filterAsync, exists, predicate } from './common'
import { packagesFullPath, scope, readPackageJson, PackageJson, resolveTopologicalSorting, dependencyKeys, POSSIBLE_SOURCE_FOLDER_NAME } from './build-all-common'
import { aggregateDeps } from './aggregate-deps'
import { select, input, confirm } from './prompt'
import { getPackagePublishInfo, getLernaPublishInfo, getPackageJsonAtCommit, getPackageYarnInfo } from './release-common'
import { getSuffixByGitFlow } from './release-branch'
import { getCurrentBranchName } from './git-utils'

interface Arguments {
  readonly noPush?: boolean
  readonly all?: boolean
}

if (require.main === module) {
  const argv: yargs.Arguments & Arguments = (
    yargs
    .strict()
    .parserConfiguration({ 'boolean-negation': false })
    .option('no-push', {
      type: 'boolean',
      nargs: 0,
      demandOption: false,
      describe: 'Only commit locally, without pushing to remote. Default is false',
    })
    .option('all', {
      type: 'boolean',
      nargs: 0,
      demandOption: false,
      describe: 'Walk through every package to let user decide whether to publish',
    })
    .help('h')
    .alias('h', 'help')
    .parse()
  )

  const { noPush, all } = argv

  Promise.resolve().then(() => run(async () => {
    const branchName = await getCurrentBranchName()

    const packageSuffix = getSuffixByGitFlow(branchName)

    return main({ noPush, all, packageSuffix })
  }))
}

export interface MainOptions {
  readonly noPush?: boolean
  readonly all?: boolean
  readonly packageSuffix?: string
}

export async function main(options?: MainOptions) {
  const noPush = Boolean(options && options.noPush)

  const packageSuffix = String(options && options.packageSuffix || '')

  const printer = new Printer()

  // 读取 lerna 发布配置
  const { message, ignoreFilters } = await getLernaPublishInfo()

  // 拉取远程tags和其他
  await exec('git fetch --tags', { silent: true })

  // 保证无未提交文件
  const resultOfDiffHead = await exec('git diff --name-only HEAD', { silent: true })
  const changedFiles = resultOfDiffHead.split(os.EOL).filter(Boolean)
  if (changedFiles.length) {
    let msg = `${chalk.redBright(`The following files are changed, unable to publish. Please ensure clean workspace.`)}\n\n`
    for (const file of changedFiles) {
      msg += `  ${chalk.yellow(file)}\n`
    }
    throw createStringError(msg)
  }

  console.log(printer.info(`no push => ${noPush}`))
  console.log(printer.info(`package prefix => ${packageSuffix}`))

  // 检查是否behind remote
  const branchStatus = await getBranchStatus()
  if (branchStatus.ahead && branchStatus.behind) {
    throw createStringError(printer.error(`The current branch has diverged from remote with ${branchStatus.ahead} ahead ${branchStatus.behind} behind, please run 'git pull'`))
  } else if (branchStatus.behind) {
    throw createStringError(printer.error(`The current branch is behind remote by ${branchStatus.behind} commits, please run 'git pull'`))
  } else if (branchStatus.ahead) {
    console.warn(printer.warn(`The current branch is ahead of remote by ${branchStatus.ahead} commits, it could be misoperation, hope you know what you're doing`))
  }

  // 扫描目录
  const allPackageNames = await (
    filterAsync(
      filterAsync(
        getDirectories(packagesFullPath),
        x => !x.match(/^\./),
      ),
      packageName => exists(path.join(packagesFullPath, packageName, 'package.json')),
    )
  )

  // 读取package.json
  const packageJsonMap = _.fromPairs(allPackageNames.map(packageName => {
    return [packageName, require(path.join(packagesFullPath, packageName, 'package.json')) as PackageJson]
  }))

  // 读取 package.json 的依赖
  const packageDeps = new Map<string, Set<string>>()
  for (const packageName of allPackageNames) {
    const { deps } = readPackageJson(packageJsonMap[packageName])
    packageDeps.set(packageName, deps)
  }

  // 从源代码读取引用关系
  const packageSourceDeps = new Map<string, Set<string>>()
  await Promise.all(allPackageNames.map(async packageName => {
    const sourceFullPathList = (
      await Promise.all(POSSIBLE_SOURCE_FOLDER_NAME.map(async folderName => {
        const fullPath = path.join(packagesFullPath, packageName, folderName)
        return await exists(fullPath) ? fullPath : undefined
      }))
    ).filter(predicate)
    const allDepPaths = await aggregateDeps({ sourceFullPathList })
    const scopeDepNames = new Set<string>()
    for (const depPaths of allDepPaths) {
      const match = depPaths.match(new RegExp(`^${scope}/([^/]+?)(/.*?)?$`, 'i'))
      if (match) {
        const depName = match[1]
        if (depName !== packageName) {
          scopeDepNames.add(depName)
        }
      }
    }
    packageSourceDeps.set(packageName, scopeDepNames)
  }))

  // 如果源代码中引用了, 但是未在 package.json 中显式引用, 抛出异常
  for (const [packageName, sourceDepNames] of packageSourceDeps) {
    const packageJsonDeps = packageDeps.get(packageName)!
    for (const depName of sourceDepNames) {
      if (packageJsonDeps.has(depName)) {
        sourceDepNames.delete(depName)
      }
    }
  }

  const hasImplicitDeps = Array.from(packageSourceDeps.values()).some(x => x.size > 0)

  if (hasImplicitDeps) {
    const lines: string[] = []
    lines.push(`${chalk.redBright(`The following packages have implicit dependencies, you can run yarn fix-implicit-dependecy to solve them`)}`)
    lines.push()
    for (const [packageName, sourceDepNames] of packageSourceDeps) {
      if (!sourceDepNames.size) continue
      lines.push(`  - ${chalk.yellow(`${scope}/${packageName}`)}`)
      for (const depName of sourceDepNames) {
        lines.push(`    - ${chalk.whiteBright(`${scope}/${depName}`)}`)
      }
    }
    throw createStringError(lines.join(os.EOL))
  }

  const packageNames = allPackageNames
  const packageNameSet = new Set(packageNames)

  // 获取包发布信息
  const {
    allTags,
    newPackageNames,
    diffsSinceLastCommit,
    lastPackageCommit,
    localCommitHashList,
    taggedCommitMap,
  } = await getPackagePublishInfo({
    scope,
    packageSuffix,
    folderNames: packageNameSet,
    ignoreFilters,
  })

  if (!newPackageNames.size && !diffsSinceLastCommit.size) {
    // 既没有新包, 旧包也没有修改, 不用发布
    console.log(printer.ok(`No changed packages`))
    return
  }

  // 构建包含带后缀和不带后缀在内所有可能包名
  const allPossibleFullPackageNames = new Set([
    ...packageNames,
    ...packageNames.map(x => x + packageSuffix),
  ])

  // 构建包版本集合 (包括tag和npm)
  console.log(printer.info('loading npm versions...'))

  const allVersionsOfFullPackageName = new Map(Array.from(allPossibleFullPackageNames).map(packageName => [packageName, new Set<string>()]))
  for (const tag of allTags) {
    const set = allVersionsOfFullPackageName.get(tag.packageName)
    if (!set) continue
    set.add(tag.version)
  }
  await Promise.all(
    Array.from(allPossibleFullPackageNames).map(async packageName => {
      const set = allVersionsOfFullPackageName.get(packageName)!
      const versions = await getPackageYarnInfo(`${scope}/${packageName}`, 'versions')
      for (const version of versions) {
        set.add(version)
      }
    })
  )

  // 构建当前分支包tag列表
  // 映射 fullPackageName => tag
  const branchTagsOfFullPackageName = new Map(Array.from(allPossibleFullPackageNames).map(packageName => [packageName, new Set<string>()]))
  for (const commitHash of localCommitHashList) {
    const commit = taggedCommitMap.get(commitHash)
    if (!commit) continue
    for (const tag of commit.tags) {
      const set = branchTagsOfFullPackageName.get(tag.packageName)
      if (!set) continue
      set.add(tag.version)
    }
  }

  // 读取上次发版 package.json 的依赖
  const lastPackageDepRanges = new Map<string, Map<string, string>>()
  const lastPackageDepVersions = new Map<string, Map<string, string>>()
  await Promise.all(Array.from(diffsSinceLastCommit.keys()).map(async packageName => {
    const commit = lastPackageCommit.get(packageName)!
    const lastPackageJson = await getPackageJsonAtCommit(commit.hash, packageName)
    const depNames = readPackageJson(lastPackageJson).deps
    const ranges = new Map<string, string>()
    lastPackageDepRanges.set(packageName, ranges)
    for (const depName of depNames) {
      for (const key of dependencyKeys) {
        const map = lastPackageJson[key]
        if (!map) continue
        const range = map[`${scope}/${depName}`]
        if (range) {
          ranges.set(depName, range)
          break
        }
      }
    }
    const versions = new Map<string, string>()
    lastPackageDepVersions.set(packageName, versions)
    await Promise.all(Array.from(ranges.keys()).map(async depName => {
      const packageJson = await getPackageJsonAtCommit(commit.hash, depName)
      versions.set(depName, packageJson.version)
    }))
  }))

  // 构建所有包原始名的拓扑排序数组
  const packageNamesInTopologicalOrder = Array.from(resolveTopologicalSorting(packageDeps))

  // 待发布的包原始名集合
  const packagesToPublish = new Set([...newPackageNames, ...diffsSinceLastCommit.keys()])

  const publishInfoMap = new Map<string, {
    oldVersion: string
    newVersion: string
    dependencies: Map<string, Dependency>
  }>()

  for (const packageName of packageNamesInTopologicalOrder) {
    const version = semver.valid(packageJsonMap[packageName].version)
    if (!version) {
      throw createStringError(printer.error(`version of ${packageName} ${JSON.stringify(packageJsonMap[packageName].version)} is not valid`))
    }

    // 分支名
    const branchPackageName = packageName + packageSuffix

    const dependencies = new Map<string, Dependency>()

    // 检查依赖版本
    for (const depName of packageDeps.get(packageName)!) {
      let newVersionOfDep: string
      const published = publishInfoMap.get(depName)
      if (published) {
        newVersionOfDep = published.newVersion
      } else {
        newVersionOfDep = packageJsonMap[depName].version
      }

      const dependency = findDependencyInPackageJson(packageName, `${scope}/${depName}`)!

      if (semver.ltr(newVersionOfDep, dependency.range)) {
        // 如果新版本低于所依赖范围, 要求重新输入
        const answer = await select(`${scope}/${packageName} requires ${scope}/${depName} in ${dependency.key} as ${JSON.stringify(dependency.range)}, which is higher than ${JSON.stringify(newVersionOfDep)}`, {
          choices: [
            { value: 'highest', name: `Use ${JSON.stringify(`^${newVersionOfDep}`)}` },
            { value: 'custom', name: `Custom Range` },
          ] as const
        })
        if (answer === 'custom') {
          const custom = await askForValidRangeByVersion(newVersionOfDep)
          dependencies.set(depName, { ...dependency, range: custom })
        } else {
          dependencies.set(depName, { ...dependency, range: `^${newVersionOfDep}` })
        }
      } else if (semver.gtr(newVersionOfDep, dependency.range)) {
        // 如果新版本高于所依赖范围, 使用提供的几个选项或者重新输入
        const answer = await select(`${scope}/${packageName} requires ${scope}/${depName} in ${dependency.key} as ${JSON.stringify(dependency.range)}, which is lower than ${JSON.stringify(newVersionOfDep)}`, {
          choices: [
            { value: 'append', name: `Use ${JSON.stringify(`${dependency.range} || ^${newVersionOfDep}`)}` },
            { value: 'highest', name: `Use ${JSON.stringify(`^${newVersionOfDep}`)}` },
            { value: 'custom', name: `Custom Range` },
          ] as const
        })
        if (answer === 'custom') {
          const custom = await askForValidRangeByVersion(newVersionOfDep)
          dependencies.set(depName, { ...dependency, range: custom })
        } else if (answer === 'append') {
          dependencies.set(depName, { ...dependency, range: `${dependency.range} || ^${newVersionOfDep}` })
        } else {
          dependencies.set(depName, { ...dependency, range: `^${newVersionOfDep}` })
        }
      } else {
        // 当前依赖包版本在范围内
        // - 如果自己要发版, 只要依赖包版本不是引用范围最小值, 都有可能有变更
        // - 如果自己不用发版, 则显然依赖包没有break代码, 所以不用发版

        // 如果曾经以分支名发版(或者当前准备发版), 往后的发版都需要读取分支名对应的版本列表, 否则读原始名的版本列表

        // 依赖包分支名
        const depBranchName = depName + packageSuffix

        // 读取分支包名的分支版本
        const depBranchVersions = branchTagsOfFullPackageName.get(depBranchName)!

        // 读取版本列表
        let validVersions: ReadonlySet<string>
        if (depBranchVersions.size > 0 || packagesToPublish.has(depName)) {
          validVersions = depBranchVersions
        } else {
          validVersions = branchTagsOfFullPackageName.get(depName)!
        }

        // 如果不是 private 包, 而且从未发过包 (无论是 master 上, 还是 branch 上 fork 的包), 都强制询问发包
        const forcePublish = !packageJsonMap[depName].private && !validVersions.size

        let shouldAsk = false
        if (
          forcePublish ||
          packagesToPublish.has(packageName) && semver.gt(newVersionOfDep, semver.minVersion(dependency.range)!)
        ) {
          shouldAsk = true
        }

        if (shouldAsk) {
          let choices = (
            [
              { value: 'keep', name: `Current ${JSON.stringify(dependency.range)}` },
              { value: 'highest', name: `Use ${JSON.stringify(`^${newVersionOfDep}`)}` },
              { value: 'custom', name: `Custom Range` },
            ] as const
          ).slice()

          // 如果当前范围中不存在任何已发布的(分支)包的tag, 不能沿用
          if (!isRangeValid(dependency.range)) {
            choices = choices.filter(x => x.value !== 'keep')
          }

          const answer = await select(`${scope}/${packageName} requires ${scope}/${depName} in ${dependency.key} as ${JSON.stringify(dependency.range)}`, {
            choices
          })
          if (answer === 'custom') {
            const custom = await askForValidRangeByVersion(newVersionOfDep)
            dependencies.set(depName, { ...dependency, range: custom })
          } else if (answer === 'highest') {
            dependencies.set(depName, { ...dependency, range: `^${newVersionOfDep}` })
          } else {
            // ignore
          }

          function isRangeValid(range: string) {
            for (const validVersion of validVersions) {
              if (semver.satisfies(validVersion, range)) {
                return true
              }
            }
            return false
          }
        }
      }
    }

    if (!packagesToPublish.has(packageName) && !dependencies.size) {
      // 包无需发布, 依赖版本也未改变, 跳过
      continue
    }

    // 所有 tag 中和 npm 中含有的这个分支包的版本都不能发
    const branchPackageVersions = allVersionsOfFullPackageName.get(branchPackageName)!
    const latestVersion = semver.maxSatisfying([...branchPackageVersions], '*') || version
    const versions = {
      current: version,
      patch: semver.inc(version, 'patch')!,
      minor: semver.inc(version, 'minor')!,
      major: semver.inc(version, 'major')!,
      next: semver.inc(latestVersion, 'patch')!,
    }

    {
      type VersionValue = (
        | 'current'
        | 'patch'
        | 'minor'
        | 'major'
        | 'custom'
        | 'next'
      )
      const choices: Array<{ value: VersionValue, name: string }> = [
        { value: 'patch', name: `Patch (${versions.patch})` },
        { value: 'minor', name: `Minor (${versions.minor})` },
        { value: 'major', name: `Major (${versions.major})` },
        { value: 'next', name: `Next (${versions.next})` },
        { value: 'custom', name: `Custom Version` },
      ]
      if (newPackageNames.has(packageName)) {
        choices.unshift({ value: 'current', name: `Current (${version})` })
      }

      do {
        const result = await select(`Select a new version for ${scope}/${packageName} (current: ${version}, latest: ${latestVersion})`, {
          choices,
        })
        let newVersion: string
        if (result === 'custom') {
          newVersion = await askForGreaterVersionThanVersion(version, branchPackageVersions)
        } else {
          newVersion = versions[result]
        }

        if (branchPackageVersions.has(newVersion)) {
          console.log(`The new version ${newVersion} existed!`)
          continue
        }

        packagesToPublish.add(packageName)
        publishInfoMap.set(packageName, {
          oldVersion: version,
          newVersion,
          dependencies,
        })
      } while (false)
    }
  }

  const hasDependencyChanges = Array.from(publishInfoMap.values()).some(x => x.dependencies.size > 0)

  console.log()
  console.log(`Changes:`)
  const changes: string[] = []
  for (const [packageName, { oldVersion, newVersion, dependencies }] of publishInfoMap) {
    changes.push(` - ${packageName}: ${oldVersion} => ${newVersion}`)
    const depMap: Record<typeof dependencyKeys[number], Record<string, string>> = {
      dependencies: {},
      devDependencies: {},
      peerDependencies: {},
    }
    for (const [depName, dependency] of dependencies) {
      depMap[dependency.key][depName] = dependency.range
    }
    for (const key of dependencyKeys) {
      for (const [depName, range] of Object.entries(depMap[key])) {
        changes.push(`   - ${scope}/${depName}: ${packageJsonMap[packageName][key]![`${scope}/${depName}`]} => ${range}`)
      }
    }
    if (hasDependencyChanges) {
      changes.push('')
    }
  }
  console.log(changes.join(os.EOL))
  console.log()

  const shouldPublish = await confirm(`Are you sure you want to create these versions?`)
  if (!shouldPublish) return

  // 修改 package.json
  await Promise.all(Array.from(publishInfoMap).map(async ([packageName, { newVersion, dependencies }]) => {
    const packageJsonFullPath = path.join(packagesFullPath, packageName, 'package.json')
    const buffer = await fs.promises.readFile(packageJsonFullPath)
    const json: PackageJson = JSON.parse(buffer.toString('utf8'))
    json.version = newVersion
    for (const [depName, dependency] of dependencies) {
      const map = json[dependency.key] || (json[dependency.key] = {})
      map[`${scope}/${depName}`] = dependency.range
    }
    await fs.promises.writeFile(packageJsonFullPath, JSON.stringify(json, null, 2) + '\n')
  }))

  // 提交修改
  {
    const beforeCommits: string[] = []
    const afterCommits: string[] = []
    const tags: string[] = []
    for (const [packageName, { newVersion }] of publishInfoMap) {
      const packageJsonFullPath = path.join(packagesFullPath, packageName, 'package.json')
      const tag = `${scope}/${packageName}${packageSuffix}@${newVersion}`
      tags.push(tag)
      beforeCommits.push(`git add ${JSON.stringify(path.relative(process.cwd(), packageJsonFullPath))}`)
      afterCommits.push(`git tag ${JSON.stringify(tag)} -m ${JSON.stringify(tag)}`)
    }
    const body = `${message}${os.EOL}${os.EOL}${tags.map(tag => ` - ${tag}`).join(os.EOL)}`
    const beforeCommand = beforeCommits.join(' && ')
    const commitCommand = `git commit -m "$(echo ${JSON.stringify(body)})"`
    const afterCommand = afterCommits.join(' && ')
    await exec(`${beforeCommand} && ${commitCommand} && ${afterCommand}`, { silent: true })
    if (noPush) {
      console.log(printer.ok(`committed locally!`))
    } else {
      await exec(`git push --follow-tags --no-verify`, { silent: true })
      console.log(printer.ok(`pushed to remote!`))
    }
  }

  function findDependencyInPackageJson(packageName: string, depName: string): Dependency | undefined {
    const json = packageJsonMap[packageName]
    for (const key of dependencyKeys) {
      const map = json[key]
      if (map) {
        const range = map[depName]
        if (range) {
          return { key, range }
        }
      }
    }
    return undefined
  }
}

interface Dependency {
  key: typeof dependencyKeys[number]
  range: string
}

class Printer {
  ok(str: string) {
    return `${this.getPrefix()} ${chalk.bold(chalk.green(`success`))} ${chalk.magenta(str)}`
  }

  error(str: string) {
    return `${this.getPrefix()} ${chalk.bgBlack(chalk.red(`ERR!`))} ${chalk.redBright(str)}`
  }

  warn(str: string) {
    return `${this.getPrefix()} ${chalk.bgBlack(chalk.yellow(`WARN`))} ${chalk.yellowBright(str)}`
  }

  info(str: string) {
    return `${this.getPrefix()} ${chalk.bgBlack(chalk.cyan(`INFO`))} ${chalk.whiteBright(str)}`
  }

  getPrefix(str = 'RELEASE') {
    return chalk.bgBlack(chalk.whiteBright(str))
  }
}

function askForValidRangeByVersion(version: string) {
  return input(`Enter a custom range`, {
    filter: semver.validRange,
    validate: r => {
      if (r === null) {
        return `Must be a valid semver version range`
      }
      if (!semver.satisfies(version, r)) {
        return `${JSON.stringify(version)} is not in range ${JSON.stringify(r)}`
      }
      return true
    },
  })
}

function askForGreaterVersionThanVersion(version: string, existed?: ReadonlySet<string>) {
  return input(`Enter a custom version greater than ${version}`, {
    filter: semver.valid,
    validate(v) {
      if (v === null) {
        return `Must be a valid semver version`
      }
      if (!semver.gt(v, version)) {
        return `Must be greater than ${version}`
      }
      if (existed && existed.has(v)) {
        return `${v} existed`
      }
      return true
    },
  })
}

async function getBranchStatus() {
  const result = await exec('git status -uno', { silent: true })
  if (result.indexOf(`have diverged`) >= 0) {
    // 同时拥有 ahead 和 behind
    // Your branch and 'origin/master' have diverged,
    // and have 1 and 1 different commits each, respectively.
    const match = result.match(/have ([0-9]+?) and ([0-9]+?)/i)
    if (match) {
      const ahead = +match[1]
      const behind = +match[2]
      return { ahead, behind }
    }
  } else if (result.indexOf(`branch is behind`) >= 0) {
    // Your branch is behind 'origin/master' by 1 commit, and can be fast-forwarded.
    const match = result.match(/by ([0-9]+?) commit/i)
    if (match) {
      const behind = +match[1]
      return { ahead: 0, behind }
    }
  } else if (result.indexOf(`branch is ahead of`) >= 0) {
    // Your branch is ahead of 'origin/master' by 1 commit.
    const match = result.match(/by ([0-9]+?) commit/i)
    if (match) {
      const ahead = +match[1]
      return { ahead, behind: 0 }
    }
  } else if (result.indexOf(`up to date`) >= 0) {
    return { ahead: 0, behind: 0 }
  } else if (result.indexOf(`nothing to commit`) >= 0) {
    return { ahead: 0, behind: 0 }
  }
  throw createStringError(`Unknown result:\n${result}`)
}
