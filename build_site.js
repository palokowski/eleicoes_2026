// Gera o site estatico em dist/, pronto para publicar em qualquer hospedagem de arquivos.
//
// Uso:
//   node build_site.js                   # baixa o resultado oficial do TSE, verifica e gera dist/
//   node build_site.js --sem-atualizar   # verifica com os CSVs oficiais ja baixados
//   node build_site.js --permitir-parcial  # gera mesmo sem recontagem verificada (mostra aviso no site)
const fs = require('node:fs');
const path = require('node:path');
const { verify, fetchFreshOfficial, VERIFICATION_FILE, RECOUNT_DIR } = require('./verificar');
const { buildResults } = require('./lib/resultados');
const { downloadFiles } = require('./lib/arquivos');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const args = process.argv.slice(2);

function main() {
  const officialDir = args.includes('--sem-atualizar') ? ROOT : fetchFreshOfficial();
  const verification = verify({ officialDir });
  fs.mkdirSync(RECOUNT_DIR, { recursive: true });
  fs.writeFileSync(VERIFICATION_FILE, JSON.stringify(verification, null, 2), 'utf8');

  for (const check of verification.checks.filter((item) => item.level !== 'ok')) {
    console.log(`[${check.level.toUpperCase()}] ${check.label}: ${check.detail}`);
  }
  if (!verification.verified && !args.includes('--permitir-parcial')) {
    // Apaga o dist/ anterior para que nada desatualizado seja publicado por engano.
    fs.rmSync(DIST, { recursive: true, force: true });
    console.error('\nSite NÃO gerado: a recontagem não bate com o resultado oficial ou está incompleta.');
    console.error('Detalhes em node verificar.js. Use --permitir-parcial só para testar o site.');
    process.exitCode = 1;
    return;
  }

  const files = downloadFiles();
  const results = { ...buildResults(), downloads: files.map(({ name, label }) => ({ name, label })) };

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'public'), DIST, { recursive: true });
  fs.mkdirSync(path.join(DIST, 'vendor', 'chart.js'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'), path.join(DIST, 'vendor', 'chart.js', 'chart.umd.js'));
  fs.mkdirSync(path.join(DIST, 'data'), { recursive: true });
  fs.writeFileSync(path.join(DIST, 'data', 'results.json'), JSON.stringify(results), 'utf8');
  fs.mkdirSync(path.join(DIST, 'dados'), { recursive: true });
  for (const file of files) fs.copyFileSync(file.source, path.join(DIST, 'dados', file.name));

  console.log(`\nSite gerado em ${DIST} (${results.mode === 'recontagem' ? 'recontagem verificada' : 'números oficiais do TSE, recontagem pendente'}).`);
}

main();
