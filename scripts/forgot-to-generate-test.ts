// tslint:disable no-console max-line-length
import { exec, run } from './common'

if (require.main === module) {
  run(main)
}

export async function main() {
  const beforeMap = new Map(
    formatStatusOutput(await exec('git status -s', { silent: true })).map(
      x => [x.path, x] as const
    )
  )

  await exec('yarn generate', { silent: true })

  const output = await exec('git status -s', { silent: true })

  const list = formatStatusOutput(output).filter(x => !beforeMap.has(x.path))

  if (!list.length) return

  console.error(`The following files are changed after running "yarn generate", did you forget to to run it before commit?`)

  for (const { line } of list) {
    console.error(line)
  }

  throw new Error('')
}

function formatStatusOutput(output: string) {
  return (
    output
    .split('\n')
    .filter(Boolean)
    .map(x => ({
      line: x,
      match: x.match(/^ *?([^ ]+?) (.*?)$/)!,
    }))
    .map(x => ({
      line: x,
      type: x.match[1],
      path: x.match[2],
    }))
  )
}
