# Marque Fácil — agenda para salão de beleza

App de celular para a profissional ver e marcar horários, acompanhar clientes e o dinheiro.
Cada salão tem sua conta. Os dados ficam no servidor **e** numa cópia no celular,
então o app abre rápido e continua funcionando sem internet (envia quando a internet voltar).

## O que faz
- **Agenda**: dia a dia, com setas e a semana em cima. Botões **Agendar** e **Vender**.
- **Agendar**: só precisa do **nome** e do **horário** (livre, ex.: 12:10). Telefone, serviço, tempo,
  valor e "já pagou?" são opcionais. Cliente e serviço novos são cadastrados sozinhos.
  Horário ocupado mostra um **aviso**, mas dá para agendar mesmo assim.
- **Clientes**: busca, WhatsApp, histórico de serviços e produtos, quanto já pagou e quanto falta.
- **Vender produto**: cliente e produto novos são cadastrados sozinhos.
- **Dinheiro**: recebido no mês, quem está devendo, atendimentos sem valor.
- **Buscar**: por nome, serviço, produto ou data.
- **Mais**: serviços, produtos, letra grande, conta, cópia de segurança.

## Estrutura
```
public/     o app (HTML/CSS/JS puro, instalável no celular)
server/     API em Node.js (Fastify + SQLite)
  src/app.js   rotas: cadastro, login, sincronização, importação
  src/db.js    banco de dados e cópias diárias
  test/        testes (npm test)
```

## Rodar no computador
```bash
cd server
npm install
npm run dev          # http://localhost:3000
npm test
```
Os dados ficam em `data/` (fora do git).

## Colocar no ar (VPS)

**O que precisa:** uma VPS com Ubuntu (ex.: Hostinger KVM 1, datacenter São Paulo) e um domínio
(ex.: registro.br). No painel do domínio, crie um registro **A** apontando para o IP da VPS.

```bash
# 1. na VPS: instalar Docker
curl -fsSL https://get.docker.com | sh

# 2. baixar o sistema
git clone https://github.com/AndreSilvaDeveloper/marquefacil.git
cd marquefacil

# 3. configurar
cp .env.example .env
nano .env            # coloque o seu DOMAIN

# 4. subir (o HTTPS é configurado sozinho)
docker compose up -d --build
```

**Atualizar** depois de mudanças: `git pull && docker compose up -d --build`
(e aumente a versão `CACHE` em `public/sw.js` para os celulares pegarem a versão nova).

**Cópias do banco:** o servidor faz uma cópia por dia (guarda 14) dentro do volume `appdata`, em `/data/backups`.
Para trazer para a VPS: `docker compose cp app:/data/backups ./backups`

## Mudança do app antigo (só no celular) para a conta
- Se ela abrir a versão nova **no mesmo endereço** do app antigo, o app oferece levar os dados para a conta.
- Vindo de outro endereço (GitHub Pages → domínio novo), o app antigo manda os dados para `/api/handoff`
  e abre `https://DOMINIO/#/migrar?code=...`; depois do login os dados entram na conta.
- Sempre funciona também pelo caminho manual: **Mais → Fazer cópia** no antigo e **Recuperar de uma cópia** no novo.
