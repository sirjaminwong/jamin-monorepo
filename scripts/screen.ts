// tslint:disable no-console max-line-length no-nested-template-literals cognitive-complexity trailing-comma arrow-parens max-classes-per-file variable-name no-identical-functions

import chalk from 'chalk'
import * as stream from 'stream'
import * as readline from 'readline'
import * as tty from 'tty'
import { EventEmitter } from 'events'
import { flatten } from 'lodash'

export const CLEAR_WHOLE_LINE = 0

export const CLEAR_RIGHT_OF_CURSOR = 1

export class Screen {
  private _renderTimer = new RenderTimer()
  private _interceptor: Interceptor
  private _destroyed = false

  private _lines: Line[] = []
  private _lastLines = 0

  constructor(
    readonly stdout: tty.WriteStream | NodeJS.WriteStream = process.stdout,
    readonly stderr: tty.WriteStream | NodeJS.WriteStream = process.stderr,
  ) {
    this._interceptor = new Interceptor(stdout, stderr)
    this._interceptor.on()
    this._interceptor.events.on('write', () => {
      this.render()
    })
  }

  get renderInterval() {
    return this._renderTimer.interval
  }

  set renderInterval(value) {
    this._renderTimer.interval = value
  }

  createLine() {
    const line = new Line(this)
    this._lines.push(line)
    return line
  }

  destroyLine(line: Line) {
    const pos = this._lines.findIndex(x => x === line)
    if (pos >= 0) {
      this._lines.splice(pos, 1)
      this._render()
    }
  }

  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    this._renderTimer.destroy()
    this._lines.splice(0)
    this._render()
    this._interceptor.off()
  }

  render() {
    this._renderTimer.next(() => {
      this._render()
    })
  }

  private _render() {
    this._interceptor.off()
    for (let i = 0; i < this._lastLines; i++) {
      readline.clearLine(this.stdout, 0)
      readline.cursorTo(this.stdout, 0)
      readline.moveCursor(this.stdout, 0, -1)
    }
    this._flush()
    const lines = flatten(this._lines.map(x => x.content.split('\n')))
    lines.unshift('')
    for (const line of lines) {
      this.stdout.write(`${line}\n`)
    }
    this._lastLines = lines.length
    this._interceptor.on()
  }

  private _flush() {
    const chunks = this._interceptor.flush()
    for (const chunk of chunks) {
      this[chunk.type].write(chunk.chunk)
    }
  }
}

export class Line {
  private _content!: string

  constructor(private _screen: Screen) {
    this.content = ''
  }

  get content() {
    return this._content
  }

  set content(value: string) {
    this._content = value
    this._screen.render()
  }

  destroy() {
    this._screen.destroyLine(this)
  }
}

export interface InterceptorChunk {
  type: 'stdout' | 'stderr'
  encoding: string
  chunk: Buffer
}

export class Interceptor {
  isOn = false

  readonly events = new EventEmitter()

  private _chunks: InterceptorChunk[] = []
  private _origin_stdout_write!: NodeJS.WritableStream['write']
  private _origin_stderr_write!: NodeJS.WritableStream['write']

  constructor(
    private stdout: tty.WriteStream | NodeJS.WriteStream,
    private stderr: tty.WriteStream | NodeJS.WriteStream,
  ) {}

  on() {
    if (this.isOn) return
    this.isOn = true
    const stdout = new stream.Writable()
    stdout._write = (buffer: Buffer, encoding, callback) => {
      const ret = this._writeChunk('stdout', buffer, encoding)
      callback()
      this.events.emit('write', ret)
    }
    const stderr = new stream.Writable()
    stderr._write = (buffer: Buffer, encoding, callback) => {
      const ret = this._writeChunk('stderr', buffer, encoding)
      callback()
      this.events.emit('write', ret)
    }
    this._origin_stdout_write = this.stdout.write
    this._origin_stderr_write = this.stderr.write
    this.stdout.write = stdout.write.bind(stdout)
    this.stderr.write = stderr.write.bind(stderr)
  }

  off() {
    if (!this.isOn) return
    this.isOn = false
    this.stdout.write = this._origin_stdout_write
    this.stderr.write = this._origin_stderr_write
    this._origin_stdout_write = undefined as unknown as NodeJS.WritableStream['write']
    this._origin_stderr_write = undefined as unknown as NodeJS.WritableStream['write']
  }

  flush() {
    const ret = this._chunks
    this._chunks = []
    return ret
  }

  private _writeChunk(type: 'stdout' | 'stderr', chunk: Buffer, encoding: string) {
    const item: InterceptorChunk = { type, encoding, chunk }
    this._chunks.push(item)
    return item
  }
}

class RenderTimer<T = unknown> {
  private _triggerAt = 0
  private _interval = 50
  private _timer?: { readonly value: NodeJS.Timeout }
  private _nextCallback?: { readonly value: () => T }

  get interval() {
    return this._interval
  }

  set interval(value) {
    value = Number(value)
    if (!(Number.isFinite(value) && value > 0)) {
      value = 0
    }
    this._interval = value
  }

  next(cb: () => T) {
    if (this._triggerAt) {
      this._nextCallback = { value: cb }
    } else {
      this._trigger(cb)
    }
  }

  destroy() {
    this._clear()
    this._nextCallback = undefined
  }

  private _trigger(cb: () => T) {
    this._triggerAt = Date.now()
    process.nextTick(cb)
    this._setTimeout()
  }

  private _setTimeout() {
    const timer = setTimeout(() => { this._callback() }, this.interval)
    this._timer = { value: timer }
  }

  private _callback() {
    this._triggerAt = 0
    if (this._nextCallback) {
      const fn = this._nextCallback.value
      this._nextCallback = undefined
      this._trigger(fn)
    }
  }

  private _clear() {
    if (this._timer) {
      clearTimeout(this._timer.value)
      this._timer = undefined
    }
  }
}

export function toStartOfLine(stdout: NodeJS.WriteStream | tty.WriteStream) {
  if (!chalk.supportsColor) {
    stdout.write('\r')
    return
  }

  readline.cursorTo(stdout, 0)
}

export function writeOnNthLine(stdout: NodeJS.WriteStream | tty.WriteStream, n: number, msg: string) {
  if (!chalk.supportsColor) {
    return
  }

  if (n === 0) {
    readline.cursorTo(stdout, 0)
    stdout.write(msg)
    readline.clearLine(stdout, CLEAR_RIGHT_OF_CURSOR)
    return
  }
  readline.cursorTo(stdout, 0)
  readline.moveCursor(stdout, 0, -n)
  stdout.write(msg)
  readline.clearLine(stdout, CLEAR_RIGHT_OF_CURSOR)
  readline.cursorTo(stdout, 0)
  readline.moveCursor(stdout, 0, n)
}

export function clearLine(stdout: NodeJS.WriteStream | tty.WriteStream) {
  if (!chalk.supportsColor) {
    if (stdout instanceof tty.WriteStream) {
      if (stdout.columns > 0) {
        stdout.write(`\r${' '.repeat(stdout.columns - 1)}`)
      }
      stdout.write(`\r`)
    }
    return
  }

  readline.clearLine(stdout, CLEAR_WHOLE_LINE)
  readline.cursorTo(stdout, 0)
}

export function clearNthLine(stdout: NodeJS.WriteStream | tty.WriteStream, n: number) {
  if (!chalk.supportsColor) {
    return
  }

  if (n === 0) {
    clearLine(stdout)
    return
  }
  readline.cursorTo(stdout, 0)
  readline.moveCursor(stdout, 0, -n)
  readline.clearLine(stdout, CLEAR_WHOLE_LINE)
  readline.moveCursor(stdout, 0, n)
}

export function clearLastNLine(stdout: NodeJS.WriteStream | tty.WriteStream, n: number) {
  if (!chalk.supportsColor) {
    return
  }
  readline.clearLine(stdout, CLEAR_WHOLE_LINE)
  for (let i = 1; i < n; i++) {
    readline.cursorTo(stdout, 0)
    readline.moveCursor(stdout, 0, -1)
    readline.clearLine(stdout, CLEAR_WHOLE_LINE)
  }
}
