#!/usr/bin/env node
// Reuse the installed Linux Electron binary and matching production dependencies.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const asar = require('@electron/asar')

async function main() {
    const [baseline, output] = process.argv.slice(2)
    if (!baseline || !output) throw new Error('Usage: build-bridge-asar.cjs installed-app.asar output.asar')
    const root = path.resolve(__dirname, '..')
    const sourcePackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json')))
    const installedPackage = JSON.parse(asar.extractFile(baseline, 'package.json'))
    const dependencies = (value) => JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)))
    if (sourcePackage.version !== installedPackage.version || dependencies(sourcePackage.dependencies) !== dependencies(installedPackage.dependencies)) {
        throw new Error('Installed version/dependencies differ; use a full Linux build instead')
    }
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'vacuumtube-bridge-asar-'))
    try {
        asar.extractAll(baseline, staging)
        fs.rmSync(path.join(staging, 'src'), {recursive: true, force: true})
        for (const name of ['src', 'assets', 'locale']) {
            const source = path.join(root, name)
            if (fs.existsSync(source)) fs.cpSync(source, path.join(staging, name), {recursive: true})
        }
        await asar.createPackage(staging, output)
        console.log('Built local bridge archive:', output)
    } finally {
        fs.rmSync(staging, {recursive: true, force: true})
    }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1 })
