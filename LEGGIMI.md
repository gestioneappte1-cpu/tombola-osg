# Tombola · Official Summer Games — su Cloudflare

App per giocare a tombola online: un banditore estrae i numeri, i giocatori li vedono in tempo reale sulle loro cartelle e i premi (ambo, terno, quaterna, cinquina, tombola) vengono assegnati in automatico.

Gira tutta su Cloudflare Workers con una Durable Object per ogni partita (piano gratuito sufficiente).

## Pubblicarla (una volta sola)

Serve Node.js 18 o più recente sul computer.

```bash
cd tombola-cf
npm install
npx wrangler login      # si apre il browser: accedi al tuo account Cloudflare
npx wrangler deploy
```

Alla fine wrangler stampa l'indirizzo, tipo `https://tombola-osg.<tuo-nome>.workers.dev`.
È questo il link da mandare ai giocatori.

Dominio tuo (facoltativo): Cloudflare Dashboard → Workers & Pages → tombola-osg → Settings → Domains & Routes → Add custom domain.

Provarla in locale: `npm run dev` e apri http://localhost:8787

## Come si gioca

- **Banditore**: apre il sito → «Crea partita» → riceve un codice di 4 lettere e un link da condividere.
- **Giocatori**: aprono il link (o il sito + codice), mettono il nome e scelgono 1–6 cartelle.
- Estrazione manuale o automatica (5/8/12/20 s). L'automatica gira sul server, anche se il telefono del banditore va in standby.
- I premi si assegnano da soli guardando le cartelle di tutti i giocatori iscritti, anche chi è momentaneamente offline. Pareggi inclusi.
- Pannello «Verifica una cartella» per controlli o assegnazioni manuali.
- Chi ricarica la pagina o perde la connessione rientra con le stesse cartelle.
- Le partite inattive si cancellano da sole dopo 3 giorni.

## File

- `public/` — sito (index.html, app.js, style.css, logo)
- `public/core.js` — regole: generazione cartelle, premi, smorfia (usato da sito e server)
- `src/worker.js` — server: crea partite, WebSocket, estrazioni, premi
- `wrangler.toml` — configurazione Cloudflare
