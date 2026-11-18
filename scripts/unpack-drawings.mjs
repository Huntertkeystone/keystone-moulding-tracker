import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';

const packs = new URL('../drawing-packs/', import.meta.url);
const drawings = new URL('../public/drawings/', import.meta.url);
const files = (await readdir(packs)).filter(name => /^pack-\d+\.json$/.test(name)).sort();
const numbers = new Set();
if (!files.length) throw new Error('No drawing packs were uploaded.');

await mkdir(drawings, { recursive: true });
for (const file of files) {
  const data = JSON.parse(await readFile(new URL(file, packs), 'utf8'));
  for (const [number, pages] of Object.entries(data)) {
    if (!/^\d+$/.test(number) || numbers.has(number)) {
      throw new Error(`Invalid or duplicate drawing number: ${number}`);
    }
    numbers.add(number);
    await writeFile(new URL(`${number}.json`, drawings), JSON.stringify(pages));
  }
}
console.log(`Prepared ${numbers.size} profile drawings.`);
