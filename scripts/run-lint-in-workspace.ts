// tslint:disable no-console max-line-length

import * as yargs from 'yargs'
import * as path from 'path'

import { run, exists, exec } from './common'

if (require.main === module) {
  run(main)
}

export async function main() {
  const rootPath = path.join(__dirname, '..')
  for (const fullFilePath of yargs.argv._) {
    const relativeFilePath = fullFilePath.replace(rootPath, '')

    let tslintJson = 'tslint.json'

    const match = relativeFilePath.match(/packages\/(.*?)\//)
    if (match) {
      const packagePath = path.join(rootPath, 'packages', match[1])
      const localTslintJson = path.join(packagePath, 'tslint.json')
      const stat = await exists(localTslintJson)
      if (stat) tslintJson = localTslintJson.replace(rootPath + '/', '')
    }

    const cmd = `node --stack_size=8192 --max-old-space-size=8192 ./node_modules/.bin/tslint -c ${tslintJson} -p tsconfig.json --fix ${fullFilePath}`
    console.log(`run: ${cmd}`)
    await exec(cmd)
  }
}
