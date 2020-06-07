// tslint:disable no-console max-line-length no-nested-template-literals cognitive-complexity trailing-comma arrow-parens

// 本脚本用于更新单个包的缓存

import * as yargs from 'yargs'
import * as path from 'path'

import { run, exists } from './common'
import { updatePackageCache, packagesFullPath } from './build-all-common'

if (require.main === module) {
  run(bin)
}

export async function bin() {
  const packageName = yargs.argv._[0] || ''
  if (!packageName) return
  const fullPackagePath = path.join(packagesFullPath, packageName)
  if (!await exists(fullPackagePath)) {
    throw new Error(`package ${JSON.stringify(packageName)} doesn't exist`)
  }
  await updatePackageCache(packageName)
}
