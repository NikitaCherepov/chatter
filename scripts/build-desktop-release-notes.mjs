#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}

function resolveFromRoot(filePath) {
  return path.resolve(projectRoot, filePath);
}

function listDesktopLocales() {
  const localesRoot = path.join(projectRoot, 'desktop-app', 'src', 'renderer', 'i18n', 'locales');
  return fs.readdirSync(localesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'));
}

function validateChanges(value, locales) {
  const changes = value?.changes;
  if (!changes || typeof changes !== 'object') {
    throw new Error('desktop-changelog.json must contain a changes object');
  }

  const expectedLength = changes.en?.length;
  if (!Number.isInteger(expectedLength) || expectedLength === 0) {
    throw new Error('changes.en must be a non-empty array');
  }

  for (const locale of locales) {
    if (!Array.isArray(changes[locale]) || changes[locale].length === 0) {
      throw new Error(`changes.${locale} must be a non-empty array`);
    }
    if (changes[locale].some((entry) => typeof entry !== 'string' || !entry.trim())) {
      throw new Error(`changes.${locale} must contain only non-empty strings`);
    }
    if (changes[locale].length !== expectedLength) {
      throw new Error(`changes.${locale} must contain ${expectedLength} entries`);
    }
  }

  return Object.fromEntries(locales.map((locale) => [locale, changes[locale]]));
}

const inputPath = resolveFromRoot(readOption('--input', 'desktop-changelog.json'));
const outputPath = resolveFromRoot(readOption('--output', 'desktop-app/release/release-notes.json'));
const checkOnly = process.argv.includes('--check');

const changelog = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const locales = listDesktopLocales();
const changes = validateChanges(changelog, locales);
const releaseNotes = `${JSON.stringify({ changes }, null, 2)}\n`;

if (checkOnly) {
  console.log(`Desktop changelog is valid: ${locales.length} language(s), ${changes.en.length} change(s) each.`);
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, releaseNotes, 'utf8');
  console.log(`Desktop release notes written to ${path.relative(projectRoot, outputPath)}.`);
}
