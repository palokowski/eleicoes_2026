// Gera o site verificado e publica no GitHub Pages (pasta docs/ do branch main).
//
// Uso:
//   node publicar.js                # so publica se a recontagem for igual ao resultado oficial do TSE
//   node publicar.js --em-andamento # publica os numeros oficiais do TSE com o aviso "recontagem em andamento"
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const DOCS = path.join(ROOT, 'docs');
const inProgress = process.argv.includes('--em-andamento');

function run(command, args) {
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' });
}

try {
  run('node', inProgress ? ['build_site.js', '--permitir-parcial'] : ['build_site.js']);
} catch {
  console.error('\nNada foi publicado.');
  process.exit(1);
}

const results = JSON.parse(fs.readFileSync(path.join(DIST, 'data', 'results.json'), 'utf8'));
const verified = results.verified;
if (!verified && !inProgress) {
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
run('git', ['commit', '-m', verified
  ? `Publica recontagem verificada (${results.recount.busRead.toLocaleString('pt-BR')} BUs, conferida em ${results.verification.checkedAt})`
  : `Publica comparação TSE × BUs, recontagem ainda com diferenças (${new Date().toISOString()})`]);
run('git', ['push']);
console.log('\nPublicado. O GitHub Pages leva um ou dois minutos para atualizar.');
