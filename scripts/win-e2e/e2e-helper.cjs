// Windows DSH e2e helper: check dsh web process/log state, then hit
// /sidebar/api/fs.search if a URL is available.
const { execSync, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')

const scratch = 'C:\\Users\\y\\dsh-e2e-scratch'

function ps() {
  try {
    const out = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | ForEach-Object { $_.ProcessId.ToString() + \\" | \\" + $_.CommandLine }"', { encoding: 'utf8', maxBuffer: 1 << 20 })
    console.log('--- node processes ---')
    console.log(out)
  } catch (err) {
    console.log('ps failed:', String(err.message).slice(0, 300))
  }
}

const args = process.argv.slice(2)
if (args.includes('--ps')) {
  ps()
} else if (args.includes('--logs')) {
  for (const name of ['web.log', 'web.err.log']) {
    const p = `${scratch}\\${name}`
    if (fs.existsSync(p)) {
      const s = fs.statSync(p)
      console.log(`--- ${name} (${s.size} bytes) ---`)
      console.log(fs.readFileSync(p, 'utf8').split('\n').slice(-15).join('\n'))
    } else {
      console.log(`--- ${name}: MISSING ---`)
    }
  }
} else if (args.includes('--search')) {
  const url = args[args.indexOf('--search') + 1]
  const query = args[args.indexOf('--search') + 2] ?? 'src'
  const payload = JSON.stringify({ sessionId: 'test', query })
  try {
    const out = execFileSync('curl.exe', ['-s', '-X', 'POST', `${url}/sidebar/api/fs.search`, '-H', 'content-type: application/json', '-d', payload], { encoding: 'utf8', maxBuffer: 1 << 20 })
    console.log('fs.search response:', out.slice(0, 2000))
  } catch (err) {
    console.log('search failed:', String(err.message).slice(0, 500))
  }
} else {
  console.log('usage: --ps | --logs | --search <url> [query]')
}