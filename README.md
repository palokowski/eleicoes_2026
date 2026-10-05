# Recontagem dos boletins de urna — Presidente 2026, 1º turno

Recontagem independente dos votos para Presidente a partir dos boletins de urna (BU) publicados pelo TSE,
de todas as seções do Brasil e do exterior, comparada voto a voto com o resultado oficial.

## Como funciona

1. **`download_bu_2026.js`** baixa cada arquivo de BU (`.dat`) do site de resultados do TSE, lê o arquivo com o
   mesmo leitor usado pelo aplicativo oficial do TSE e soma os votos de cada candidato por estado e no exterior.
2. **`apuracao_presidente.py`** baixa o resultado oficial publicado pelo TSE (Brasil, estados e municípios).
3. **`verificar.js`** compara as duas coisas: os votos de cada candidato no Brasil, em cada estado e no exterior
   precisam ser exatamente iguais, todos os BUs precisam ter sido lidos e nenhum pode ter falhado.
4. **`build_site.js`** gera o site em `dist/`. Se a verificação falhar, o site não é gerado.

## Rodar

Requer Node.js 18+ e Python 3.

```bash
npm install
npx playwright install chromium
pip install requests

python apuracao_presidente.py      # resultado oficial do TSE
node download_bu_2026.js           # baixa e reconta todos os BUs (demora horas; pode ser retomado)
node verificar.js                  # compara recontagem x TSE
node build_site.js                 # gera o site em dist/
node publicar.js                   # gera, verifica e publica no GitHub Pages (pasta docs/)
```

Para ver o site localmente: `npm start` e abra http://localhost:3000.

## Dados

- `data/2026/1-turno/votos_presidente_bu.csv`: votos recontados por candidato.
- `data/2026/1-turno/reconciliacao_presidente_bu.json`: BUs lidos, falhas e seções sem BU.
- `data/2026/1-turno/verificacao.json`: comparação com o resultado oficial do TSE.
- Os arquivos de BU não estão no repositório (centenas de MB). Eles são públicos e o `download_bu_2026.js`
  baixa todos de novo direto do TSE.
