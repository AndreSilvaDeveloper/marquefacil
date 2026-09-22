# Deploy no servidor de dev (máquina `nd2`, junto com o WorkID dev)

O app roda em `/opt/marquefacil`, só no endereço interno (porta 3100). O Caddy que já existe
na máquina faz o HTTPS e repassa para ele. O deploy é pelo GitHub Actions (**Actions → Deploy dev →
Run workflow**), num runner próprio do Marque Fácil.

> ⚠️ Máquina compartilhada: não escrever em `/var/www/workid`, não mexer no runner `nd2-workid-dev`,
> não usar `docker compose down --remove-orphans` fora do projeto `marquefacil`.
> Mudanças no Caddy, firewall ou portas: combinar antes com o dono da máquina.

## 1. Como a máquina está (conferido em 22/09/2026)
- Ubuntu 24.04, 2 CPUs, 7,8 GB de RAM (4,6 GB livres), 63 GB livres em disco.
- Rodam também: WorkID dev (`ponto-pro-dev*`), zenfra (`zenfrapp-web`), vault (`vault-app-1`),
  finance (`finance-api`) e cloudbeaver. Runners: `nd2-workid-dev`, `nd2-zenfra-landing`, `nd2` (RPG).
- **Caddy em container** (`caddy`, compose em `/var/www/caddy`), Caddyfile em `/var/www/caddy/Caddyfile`.
  Ele entra na rede de cada app e chama o container pelo nome.
- ⚠️ O `docker-compose.yml` do Caddy está desatualizado (declara `vault-default`, a rede real é
  `vault_default`; a rede do WorkID foi conectada à mão). **Não recriar o Caddy com
  `docker compose up`** — use `docker network connect` e `caddy reload`, que não derrubam nada.
- Firewall (ufw): só 443 aberto para a internet; SSH só pela tailnet.
- Porta 3100 livre.

## 2. Pasta do app (uma vez)
```bash
mkdir -p /opt/marquefacil && chown ghrunner:ghrunner /opt/marquefacil
```

## 3. Runner do Marque Fácil (uma vez)
Token (vale 1h), gerado de qualquer máquina com `gh` logado:
```bash
gh api -X POST repos/AndreSilvaDeveloper/marquefacil/actions/runners/registration-token --jq .token
```
No servidor, como root:
```bash
mkdir -p /opt/actions-runner-marquefacil && chown ghrunner:ghrunner /opt/actions-runner-marquefacil
cd /opt/actions-runner-marquefacil
# mesma versão do runner do WorkID: ls /opt/actions-runner/bin/ | head  (ou a última do GitHub)
V=$(curl -s https://api.github.com/repos/actions/runner/releases/latest | grep -oP '"tag_name": "v\K[^"]+')
sudo -u ghrunner curl -sL -o runner.tar.gz \
  https://github.com/actions/runner/releases/download/v$V/actions-runner-linux-x64-$V.tar.gz
sudo -u ghrunner tar xzf runner.tar.gz
sudo -u ghrunner ./config.sh --url https://github.com/AndreSilvaDeveloper/marquefacil \
  --token <TOKEN> --name nd2-marquefacil --labels marquefacil-dev --unattended
./svc.sh install ghrunner
./svc.sh start
```

## 4. Variáveis no GitHub (uma vez)
Repositório → **Settings → Secrets and variables → Actions**.

| Tipo | Nome | Valor |
|---|---|---|
| Variable | `DOMAIN` | `maquefacil.com.br` |
| Variable | `APP_PORT` | `3100` (opcional) |
| Variable | `ALLOW_SIGNUP` | `true` |
| Secret | `EVOLUTION_URL` | URL da Evolution API (etapa 2) |
| Secret | `EVOLUTION_APIKEY` | chave da Evolution API (etapa 2) |

## 5. Domínio (painel da Hostinger → DNS)
| Tipo | Nome | Aponta para |
|---|---|---|
| A | `@` | `77.37.40.221` |
| A | `www` | `77.37.40.221` |

Conferir: `dig +short maquefacil.com.br` deve mostrar `77.37.40.221`.

## 6. Caddy (depois do 1º deploy e com o DNS já apontando)
O workflow já conecta o Caddy à rede `marquefacil`. Falta acrescentar o bloco de
[`Caddyfile.snippet`](Caddyfile.snippet) no **fim** de `/var/www/caddy/Caddyfile` (não substituir) e recarregar:
```bash
cp /var/www/caddy/Caddyfile /var/www/caddy/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)
cat deploy/Caddyfile.snippet | grep -v '^#' >> /var/www/caddy/Caddyfile
docker exec caddy caddy validate --config /etc/caddy/Caddyfile
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

## 7. Primeiro deploy
GitHub → Actions → **Deploy dev** → Run workflow (branch `dev`). O workflow:
testa → constrói a imagem → gera `/opt/marquefacil/.env` → `docker compose up -d` → confere `/api/health`.

## Dia a dia
```bash
cd /opt/marquefacil
docker compose -p marquefacil logs -f --tail 100
docker compose -p marquefacil restart
docker compose -p marquefacil cp app:/data/backups ./backups   # cópias diárias do banco
```
A máquina não é nossa e não tem backup próprio: vale copiar `backups/` para fora dela de tempos em tempos.
