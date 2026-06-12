import { main } from './cli/index'

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`${String(err)}\n`)
  process.exitCode = 1
})
