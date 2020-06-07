import * as ts from 'typescript'
import * as path from 'path'
import { readFileSafeSync } from './common'

export function readTsConfigFile(fileName: string) {
  const currentDirectory = path.dirname(fileName)
  const { config, error } = ts.readConfigFile(fileName, file => {
    const buffer = readFileSafeSync(file)
    if (!buffer) return
    return buffer.toString('utf8')
  })
  if (error) {
    const errorString = ts.formatDiagnostic(error, {
      getCurrentDirectory: () => currentDirectory,
      getCanonicalFileName: x => x,
      getNewLine: () => '\n'
    })
    throw new Error(errorString)
  }
  const parsedOptions = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(fileName))
  return parsedOptions.options
}
