import { scope, PackageJson } from './build-all-common'
import immer from 'immer'

export const PACKAGE_NAME_SUFFIX_SEPARATOR = '--'

export const ORIGINAL_PACKAGE_NAME_FIELD = 'arkieOriginalPackageName'

/**
 * 获取分支发布信息
 */
export function getReleaseBranchInfo() {
  const commitMessage = process.env.CI_COMMIT_MESSAGE
  const branchName = process.env.CI_COMMIT_REF_NAME || ''

  const packageSuffix = getSuffixByGitFlow(branchName)

  const publish = Boolean(
    commitMessage &&
    commitMessage.includes(`chore(release): publish`) &&
    (branchName === 'master' || packageSuffix || branchName.match(/^publish\//))
  )

  return { commitMessage, branchName, packageSuffix, publish }
}

/**
 * 从分支名获取包后缀
 * @param branchName 分支名
 */
export function getSuffixByGitFlow(branchName: string) {
  const matches = branchName.match(/^(dev|staging|release)\/(.+)$/)
  if (matches) {
    const [stage, description] = matches.splice(1)
    return `${PACKAGE_NAME_SUFFIX_SEPARATOR}for-${stage}-${description.replace(/\//g, '-')}`
  }
  return ''
}

export function toPackageShiftedName(folderName: string, suffix: string) {
  return scope + '/' + folderName + suffix
}

export function injectSuffixToPackageJson(
  originalPackageJson: PackageJson,
  originalPackageName: string,
  newPackageNameMap: ReadonlyMap<string, string>,
  packageJsonMap: ReadonlyMap<string, Readonly<PackageJson>>,
) {
  const newPackageName = newPackageNameMap.get(originalPackageName)
  if (!newPackageName) {
    throw new Error(`new package name of ${originalPackageName} not found`)
  }

  return immer(originalPackageJson, packageJson => {
    packageJson[ORIGINAL_PACKAGE_NAME_FIELD] = `${scope}/${originalPackageName}`
    packageJson.name = `${scope}/${newPackageName}`

    for (const depFieldName of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
      const depMap = packageJson[depFieldName]
      if (!depMap) continue
      for (const depName of Object.keys(depMap)) {
        if (depName.indexOf(`${scope}/`) !== 0) continue
        const originalDepName = depName.slice(`${scope}/`.length)
        const depPackageJson = packageJsonMap.get(originalPackageName)
        if (!depPackageJson || depPackageJson.private) continue
        const newDepName = newPackageNameMap.get(originalDepName)
        if (!newDepName) continue
        depMap[depName] = toAliasPackageName(`${scope}/${newDepName}`, depMap[depName])
      }
    }
  })
}

export function toAliasPackageName(packageName: string, range: string) {
  return `npm:${packageName}@${range}`
}
