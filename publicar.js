// Gera o site verificado e publica no GitHub Pages (pasta docs/ do branch main).
//
// Uso: node publicar.js
//
// So publica se a recontagem dos BUs for igual ao resultado oficial do TSE.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const DOCS = path.join(ROOT, 'docs');

function run(command, args) {
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' });
}

try {
  run('node', ['build_site.js']);
} catch {
  console.error('\nNada foi publicado.');
  process.exit(1);
}

const results = JSON.parse(fs.readFileSync(path.join(DIST, 'data', 'results.json'), 'utf8'));
if (results.mode !== 'recontagem' || !results.verification?.verified) {
  console.error('\nNada foi publicado: o site gerado não está com a recontagem verificada.');
  process.exit(1);
}

fs.rmSync(DOCS, { recursive: true, force: true });
fs.cpSync(DIST, DOCS, { recursive: true });
fs.writeFileSync(path.join(DOCS, '.nojekyll'), '');

run('git', ['add', '-A']);
const changed = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
if (!changed) {
  console.log('\nO site publicado já está atualizado.');
  process.exit(0);
}
run('git', ['commit', '-m', `Publica recontagem verificada (${results.verification.totals.buFiles.toLocaleString('pt-BR')} BUs, conferida em ${results.verification.checkedAt})`]);
run('git', ['push']);
console.log('\nPublicado. O GitHub Pages leva um ou dois minutos para atualizar.');
