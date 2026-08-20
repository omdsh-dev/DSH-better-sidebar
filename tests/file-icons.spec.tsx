import { describe, expect, it } from 'vitest'
import { isValidElement } from 'react'
import { fileIconFor } from '../src/client/icons.tsx'

describe('fileIconFor', () => {
  it('returns valid React element for empty or unknown filenames', () => {
    const icon1 = fileIconFor('')
    expect(isValidElement(icon1)).toBe(true)

    const icon2 = fileIconFor('unknown.xyz')
    expect(isValidElement(icon2)).toBe(true)
  })

  it('renders icons for special configuration files', () => {
    const specialFiles = [
      'Dockerfile',
      'dockerfile.dev',
      'docker-compose.yml',
      'docker-compose.yaml',
      '.dockerignore',
      '.gitignore',
      '.gitmodules',
      '.gitattributes',
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'yarn.lock',
      'bun.lockb',
      'tsconfig.json',
      'tsconfig.build.json',
      'jsconfig.json',
      'vite.config.ts',
      'vite.config.js',
      'tailwind.config.js',
      'eslint.config.js',
      '.eslintrc.json',
      'prettier.config.js',
      '.prettierrc',
      'Cargo.toml',
      'Cargo.lock',
      'go.mod',
      'go.sum',
      'requirements.txt',
      'Pipfile',
      'poetry.lock',
      'pyproject.toml',
      '.env',
      '.env.local',
      '.env.production',
      'LICENSE',
      'LICENCE',
      'README.md',
      'README',
      'CHANGELOG.md',
    ]

    for (const file of specialFiles) {
      const icon = fileIconFor(file)
      expect(isValidElement(icon), `Failed for ${file}`).toBe(true)
    }
  })

  it('renders icons for common programming languages and extensions', () => {
    const extFiles = [
      'index.ts',
      'index.mts',
      'index.cts',
      'App.tsx',
      'index.js',
      'index.mjs',
      'index.cjs',
      'App.jsx',
      'Component.vue',
      'Component.svelte',
      'Page.astro',
      'script.py',
      'script.pyw',
      'notebook.ipynb',
      'main.rs',
      'main.go',
      'main.cpp',
      'main.c',
      'main.h',
      'main.hpp',
      'Program.cs',
      'Main.java',
      'Main.kt',
      'Main.swift',
      'index.php',
      'app.rb',
      'main.dart',
      'script.lua',
      'main.zig',
      'Main.scala',
      'index.html',
      'style.css',
      'style.scss',
      'style.sass',
      'style.less',
      'data.json',
      'data.jsonc',
      'config.yaml',
      'config.yml',
      'config.toml',
      'config.ini',
      'config.xml',
      'doc.md',
      'doc.markdown',
      'doc.mdx',
      'script.sh',
      'script.bash',
      'script.zsh',
      'script.ps1',
      'script.bat',
      'schema.sql',
      'schema.prisma',
      'schema.graphql',
      'service.proto',
      'module.wasm',
      'document.pdf',
      'image.png',
      'image.jpg',
      'image.jpeg',
      'image.gif',
      'image.webp',
      'icon.svg',
      'icon.ico',
      'doc.docx',
      'doc.doc',
      'sheet.xlsx',
      'sheet.xls',
      'sheet.csv',
      'slide.pptx',
      'audio.mp3',
      'video.mp4',
      'archive.zip',
      'archive.tar.gz',
      'font.woff2',
      'notes.txt',
      'debug.log',
    ]

    for (const file of extFiles) {
      const icon = fileIconFor(file)
      expect(isValidElement(icon), `Failed for ${file}`).toBe(true)
    }
  })

  it('handles paths with directory prefixes correctly', () => {
    const icon1 = fileIconFor('src/client/icons.tsx')
    expect(isValidElement(icon1)).toBe(true)

    const icon2 = fileIconFor('/root/workspace/.gitignore')
    expect(isValidElement(icon2)).toBe(true)

    const icon3 = fileIconFor('C:\\projects\\app\\package.json')
    expect(isValidElement(icon3)).toBe(true)
  })
})
