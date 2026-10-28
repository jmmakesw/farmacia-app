# Farmácia — app web instalável (PWA)

App para uma farmácia, em português, que funciona no browser e se **instala no ecrã inicial do Android e do iPhone/iPad**.

**O que já faz**

- **Login**: criar conta, entrar e terminar sessão (com consentimento para tratamento de dados no registo).
- **Montra** de produtos com pesquisa (sem distinguir acentos), filtro «Venda livre / Com receita» e categorias.
- **Pedidos** de medicamentos e produtos para **levantar na farmácia**:
  - venda livre: basta enviar;
  - com receita: o cliente indica o **número da receita eletrónica** (com código de acesso) **ou** envia **fotografia/PDF** da receita.
- **Histórico** de pedidos do cliente, com estado (Recebido → Em preparação → Pronto para levantar → Levantado) e cancelamento enquanto o pedido é novo.
- **Painel da farmácia** (conta de pessoal): lista de pedidos por tratar, dados do cliente, receita (número com botões de copiar, ou imagem/PDF) e botões para avançar o estado.
- Funciona **offline** (abre a app e a última montra vista) e atualiza sozinha.

> Os produtos e preços que vêm incluídos são **apenas de exemplo**.

## Como correr

Precisa de [Node.js](https://nodejs.org) **22.13 ou superior**. Não há nada para instalar (sem dependências externas).

```bash
npm start
```

Abra http://localhost:3000. Na **primeira vez**, o terminal mostra o email e a palavra-passe da conta da farmácia (o painel aparece ao entrar com ela). Para escolher você mesmo, defina antes de arrancar:

```bash
STAFF_EMAIL=geral@minhafarmacia.pt STAFF_PASSWORD='uma-palavra-passe-forte' npm start
```

Testes automáticos: `npm test`.

## Pôr online (necessário para instalar no telemóvel)

Android e iOS só deixam instalar a app se o site estiver em **HTTPS** (em `localhost` funciona para testar no computador). Alojamento típico: um servidor/VPS ou um serviço que corra Node, com um proxy HTTPS à frente (Caddy, Nginx, etc.).

| Variável | Para quê |
|---|---|
| `PORT` | Porta do servidor (por omissão 3000) |
| `DATA_DIR` | Pasta da base de dados e das receitas (por omissão `./data`) |
| `TRUST_PROXY=1` | Use quando estiver atrás de um proxy HTTPS (lê o IP real e marca o cookie como seguro) |
| `COOKIE_SECURE=1` | Força o cookie de sessão a só viajar por HTTPS |
| `STAFF_EMAIL`, `STAFF_PASSWORD` | Conta inicial da farmácia (só é criada se ainda não existir nenhuma) |

**Cópias de segurança:** guarde regularmente a pasta `DATA_DIR` (contém `farmacia.db` e a pasta `uploads/` com as receitas).

**Instalar no telemóvel**
- *Android (Chrome):* menu ⋮ → «Instalar aplicação» (ou o botão «Instalar app» no separador Conta).
- *iPhone/iPad (Safari):* Partilhar → «Adicionar ao ecrã principal».

## Personalizar

- **Nome da farmácia:** `PHARMACY` em `public/app.js`, `<title>` em `public/index.html`, e `name`/`short_name` em `public/manifest.webmanifest`.
- **Cores e ícone:** cores em `public/styles.css` (variáveis no topo); ícone em `scripts/make-icons.py` (depois `npm run icons`).
- **Produtos:** os de exemplo estão em `src/seed.js` e só são criados com a base de dados vazia. Ainda não há ecrã para gerir o catálogo (ver «Próximos passos»).
- **Depois de alterar ficheiros em `public/`:** mude `VERSION` em `public/sw.js` para os telemóveis receberem a atualização.

## Segurança (resumo)

Palavras-passe com scrypt; sessões no servidor (cookie `HttpOnly`, `SameSite=Strict`); limite de tentativas no login/registo; preços sempre calculados no servidor; as receitas só são acessíveis ao próprio cliente e à farmácia, guardadas com nomes aleatórios fora da pasta pública e com o tipo de ficheiro verificado; política de segurança de conteúdo (CSP) restritiva; todo o texto é inserido como texto (sem HTML).

## Antes de abrir ao público

Isto é uma base funcional, não um produto jurídico fechado. Confirme com quem trata da conformidade da farmácia:

- **RGPD:** as receitas são **dados de saúde**. Falta publicar uma política de privacidade, definir prazos de conservação e como atender pedidos de acesso/apagamento. Recomenda-se também cifrar o disco do servidor.
- **Regras do setor (INFARMED / Ordem dos Farmacêuticos)** sobre pedidos à distância e dispensa de medicamentos com receita. A app **não cobra nem dispensa nada**: o pedido só fica válido depois de o farmacêutico o validar e o cliente levantar na farmácia.

## Próximos passos possíveis

Gestão do catálogo e do stock num ecrã próprio · recuperar palavra-passe por email · avisos por email/notificação quando o pedido está pronto · apagar conta e dados · fotografias dos produtos · vários utilizadores de pessoal.

## Estrutura

```
server.js          servidor HTTP e ficheiros estáticos
src/api.js         rotas: contas, produtos, pedidos, receitas
src/security.js    palavras-passe, sessões, limites, origem
src/db.js          base de dados SQLite (módulo nativo do Node)
src/seed.js        produtos de exemplo e conta da farmácia
src/multipart.js   leitura de uploads
public/            a app (index.html, app.js, styles.css, sw.js, manifest, ícones)
test/smoke.js      testes ponta a ponta
```
