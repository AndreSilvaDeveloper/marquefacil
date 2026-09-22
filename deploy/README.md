# Deploy no servidor de dev (máquina `nd2`, junto com o WorkID dev)

O app roda em `/opt/marquefacil`, só no endereço interno (porta 3100). O Caddy que já existe
na máquina faz o HTTPS e repassa para ele. O deploy é pelo GitHub Actions (**Actions → Deploy dev →
Run workflow**), num runner próprio do Marque Fácil.

> ⚠️ Máquina compartilhada: não escrever em `/var/www/workid`, não mexer no runner `nd2-workid-dev`,
> não usar `docker compose down --remove-orphans` fora do projeto `marquefacil`.
> Mudanças no Caddy, firewall ou portas: combinar antes com o dono da máquina.

## 1. Conferir antes (como root)
```bash
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'   # Caddy é container ou systemd?
systemctl is-active caddy
ls /etc/caddy/Caddyfile
ss -tlnp | grep -E ':3100\b' || echo "3100 livre"
free -h; df -h /; nproc
systemctl list-units 'actions.runner.*' --no-pager       # runner do WorkID (não mexer)
```

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
| Variable | `APP_BIND` | `127.0.0.1` (Caddy na máquina) ou `172.17.0.1` (Caddy em container) |
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

## 6. Caddy
Acrescentar o bloco de [`Caddyfile.snippet`](Caddyfile.snippet) no Caddyfile que já existe
(**não substituir** o arquivo), escolhendo a opção certa. Depois:
```bash
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
# se for container: docker exec <caddy> caddy reload --config /etc/caddy/Caddyfile
```
Só faça isso **depois** que o DNS já estiver apontando, senão o Caddy tenta tirar o certificado e falha.

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
