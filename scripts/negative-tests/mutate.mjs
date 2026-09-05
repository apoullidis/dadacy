// Plant one violation. Refuses to be a no-op: if the anchor is not found the
// mutation exits non-zero, so a case can never "pass" because the file was
// never changed. (That is not hypothetical — the first version of this
// harness used python3, which is not in the toolbox, and fourteen cases
// reported PASS against an unmodified tree.)
import fs from 'node:fs';
const [, , file, from, to] = process.argv;
const s = fs.readFileSync(file, 'utf8');
if (!s.includes(from)) {
  console.error(
    `MUTATION FAILED: anchor not found in ${file}: ${JSON.stringify(from.slice(0, 60))}`,
  );
  process.exit(1);
}
fs.writeFileSync(file, s.replace(from, to));
