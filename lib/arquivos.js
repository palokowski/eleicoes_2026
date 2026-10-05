const fs = require('node:fs');
const path = require('node:path');
const { ROOT, RECOUNT_DIR } = require('./resultados');

// Arquivos publicados para quem quiser auditar a recontagem.
function downloadFiles() {
  return [
    { name: 'votos_presidente_bu.csv', source: path.join(RECOUNT_DIR, 'votos_presidente_bu.csv'), label: 'Recontagem dos BUs por candidato (Brasil, UFs, exterior)' },
    { name: 'reconciliacao_presidente_bu.json', source: path.join(RECOUNT_DIR, 'reconciliacao_presidente_bu.json'), label: 'Relatório da recontagem (BUs lidos, falhas, seções)' },
    { name: 'verificacao.json', source: path.join(RECOUNT_DIR, 'verificacao.json'), label: 'Comparação com o resultado oficial do TSE' },
    { name: 'votos_presidente_tse.csv', source: path.join(ROOT, 'votos_presidente.csv'), label: 'Resultado oficial do TSE por candidato (inclui municípios)' },
    { name: 'apuracao_presidente_tse.csv', source: path.join(ROOT, 'apuracao_presidente.csv'), label: 'Resultado oficial do TSE: eleitorado, comparecimento, brancos, nulos' }
  ].filter((file) => fs.existsSync(file.source));
}

module.exports = { downloadFiles };
