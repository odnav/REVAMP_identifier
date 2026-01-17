# Migração de VM (bot REVAMP_identifier)

Este guia descreve **apenas a migração da VM** (não é criar o bot do zero). O objetivo é mover o serviço para uma nova VM e puxar a última versão via Git.

## 1) Preparação na VM atual (origem)

1. **Confirma o estado do bot** (opcional):
   ```bash
   systemctl status revamp-identifier
   ```

2. **Garante que tens acesso ao repositório** (origin remoto correto):
   ```bash
   git -C /root/discordbot/REVAMP_identifier remote -v
   ```

3. **Faz backup do `.env` e de outros ficheiros locais** (se existirem alterações fora do Git):
   ```bash
   sudo cp /root/discordbot/REVAMP_identifier/.env /root/discordbot/REVAMP_identifier/.env.backup
   ```

4. **Exporta a base de dados** (ajusta utilizador/DB conforme a tua configuração):
   ```bash
   pg_dump -U revamp -h 127.0.0.1 -p 5432 revampadmin > /root/backup_revampadmin.sql
   ```

5. **Copia os backups para a nova VM** (exemplo com `scp`):
   ```bash
   scp /root/discordbot/REVAMP_identifier/.env.backup root@NOVA_VM:/root/
   scp /root/backup_revampadmin.sql root@NOVA_VM:/root/
   ```

> Se preferires, podes também copiar o serviço systemd (se existir):
> ```bash
> scp /etc/systemd/system/revamp-identifier.service root@NOVA_VM:/root/
> ```

## 2) Preparação na nova VM (destino)

1. **Instala as dependências base** (Node.js, PostgreSQL, Git):
   ```bash
   sudo apt update
   sudo apt install -y git postgresql postgresql-contrib
   ```

2. **Clona o repositório** para o caminho esperado:
   ```bash
   mkdir -p /root/discordbot
   cd /root/discordbot
   git clone <URL_DO_REPO> REVAMP_identifier
   ```

3. **Puxa a última versão** (garante que estás no branch correto):
   ```bash
   cd /root/discordbot/REVAMP_identifier
   git checkout main
   git pull origin main
   ```

4. **Restaura o `.env`**:
   ```bash
   sudo mv /root/.env.backup /root/discordbot/REVAMP_identifier/.env
   sudo chown root:root /root/discordbot/REVAMP_identifier/.env
   ```

5. **Restaura a base de dados**:
   ```bash
   sudo -u postgres psql -c "CREATE USER revamp WITH PASSWORD 'muda_isto';"
   sudo -u postgres psql -c "CREATE DATABASE revampadmin OWNER revamp;"
   psql "postgresql://revamp:muda_isto@127.0.0.1:5432/revampadmin" < /root/backup_revampadmin.sql
   ```

> Se a BD já existir, salta os comandos `CREATE` e importa apenas o dump.

6. **Instala as dependências Node.js**:
   ```bash
   cd /root/discordbot/REVAMP_identifier
   npm install
   ```

7. **(Opcional) Regista/atualiza slash commands**:
   ```bash
   npm run deploy
   ```

## 3) Serviço systemd (opcional, mas recomendado)

1. **Se já tinhas um serviço**, copia-o para `/etc/systemd/system/`:
   ```bash
   sudo mv /root/revamp-identifier.service /etc/systemd/system/revamp-identifier.service
   ```

2. **Recarrega e ativa o serviço**:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now revamp-identifier
   sudo systemctl status revamp-identifier
   ```

## 4) Verificação final

1. **Verifica se o bot está online** no Discord.
2. **Confirma os logs**:
   ```bash
   sudo journalctl -u revamp-identifier -f
   ```

## 5) Notas úteis

- Se houver mudanças recentes no repositório, repete o passo de `git pull`.
- Mantém o `.env` **fora do Git**.
- Se trocares de host/porta PostgreSQL, atualiza as variáveis `PG*` no `.env`.
