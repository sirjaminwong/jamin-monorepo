// tslint:disable no-console max-line-length

import * as path from 'path'
import * as fs from 'fs'
import * as ts from 'typescript'
import { lint, AnyInfo } from 'type-coverage-core'
import { run } from './common'
import chalk from 'chalk'
import * as yargs from 'yargs'

interface Arguments {
  readonly percent?: number
}

if (require.main === module) {
  const argv: yargs.Arguments & Arguments = (
    yargs
    .strict()
    .alias('p', 'percent')
    .option('percent', {
      type: 'number',
      nargs: 1,
      demandOption: false,
      describe: 'how many percent should type be coveraged. Range in [0, 100], default 100',
    })
    .help('h')
    .alias('h', 'help')
    .parse()
  )

  const { percent } = argv
  const sourcePathList = argv._.map(p => path.resolve(process.cwd(), p))

  run(() => main({
    percent,
    sourcePathList,
  }))
}

export interface MainOptions {
  /**
   * 至少多少%, 范围 0-100
   */
  readonly percent?: number
  readonly sourcePathList?: readonly string[]
}

export async function main(options?: MainOptions) {
  // 源文件列表
  const sourcePathList = options && options.sourcePathList || []
  if (!sourcePathList.length) return

  // 至少多少%, 单位%
  const AT_LEAST = formatAtLeastPercent(options && options.percent)

  const results = await Promise.all(sourcePathList.map(async sourcePath => {
    const result = await lint(sourcePath, {
      ignoreCatch: true,
    })
    const { anys } = result
    const program: ts.Program = result.program
    const rootFileNames = new Set(program.getRootFileNames())
    const ignoredAnys: AnyInfo[] = []
    const pickedAnys: AnyInfo[] = []
    for (const x of anys) {
      if (rootFileNames.has(x.file)) {
        pickedAnys.push(x)
      } else {
        ignoredAnys.push(x)
      }
    }

    return {
      ...result,
      correctCount: result.correctCount + ignoredAnys.length,
      anys: pickedAnys,
    }
  }))

  const totalCount = results.reduce((s, x) => s + x.totalCount, 0)
  const correctCount = results.reduce((s, x) => s + x.correctCount, 0)

  const percentage = correctCount / totalCount
  const percent = (percentage >= 0 ? percentage <= 1 ? percentage : 1 : 0) * 100

  if (percent >= AT_LEAST) {
    console.log(`${correctCount} / ${totalCount} ${formatPercent(percent)}% >= ${formatPercent(AT_LEAST)}% ${chalk.green(`✔`)}`)
    return
  }

  const logsList = await Promise.all(results.map(async result => {
    const logs: string[] = []
    const { anys } = result
    const program: ts.Program = result.program
    const codes = new Map(
      await Promise.all(
        Array.from(new Set(anys.map(x => x.file))).map(async file => {
          const filePath = program.getSourceFile(file)!.fileName
          const buffer = await fs.promises.readFile(filePath)
          return [file, buffer.toString('utf8')] as const
        })
      )
    )
    for (const info of anys) {
      const code = codes.get(info.file)!
      logs.push(printCode(info, code))
    }
    return logs
  }))

  for (const logs of logsList) {
    for (const log of logs) {
      console.log(log)
    }
  }

  console.log(`${correctCount} / ${totalCount} ${formatPercent(percent)}% < ${formatPercent(AT_LEAST)}% ${chalk.red(`✘`)}`)

  process.exit(1)
}

function printCode(info: AnyInfo, code: string) {
  const { file, line, character, text } = info
  const offset = getLineOffsetOfCode(code, line)
  if (!offset) return ''
  const wave = '~'.repeat(text.length)
  return [
    '',
    `${chalk.cyan(file)}:${chalk.yellow(String(line))}:${chalk.yellow(String(character))}`,
    `${chalk.bgWhite(chalk.black(String(line)))} ${code.slice(offset.offset, offset.endOffset)}`,
    `${chalk.bgWhite(chalk.black(' '.repeat(String(line).length)))} ${' '.repeat(character)}${chalk.redBright(wave)}`,
    '',
  ].join('\n')
}

function getLineOffsetOfCode(code: string, lineNumber: number) {
  let n = lineNumber
  let offset = 0
  while (n > 0) {
    offset = code.indexOf('\n', offset) + 1
    n--
  }
  if (!~offset) return
  const endOffset = code.indexOf('\n', offset)
  if (!~endOffset) return
  return { offset, endOffset }
}

function formatPercent(x: number) {
  return +(Math.floor(x * 100) / 100).toFixed(2)
}

function formatAtLeastPercent(x: unknown) {
  if (typeof x === 'number') {
    if (Number.isNaN(x)) return 100
    if (x < 0) return 0
    if (x > 100) return 100
    return x
  }
  return 100
}
