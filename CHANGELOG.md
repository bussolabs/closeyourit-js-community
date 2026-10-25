# Changelog

## [Unreleased]

## [0.15.0] - 2026-10-22

### Changed

- **Più facile da trovare su npm.** Cercando «closeyourit» il pacchetto ora compare, e la descrizione cita anche statistiche visite senza cookie e registrazione delle sessioni.
- **Note tecniche in inglese.** I commenti dei file di configurazione principali (`vitest.config.ts`, `tsup.config.ts`, `tsconfig.json`, `pnpm-workspace.yaml`) e le note nei `package.json` degli esempi `examples/nuxt`, `examples/nuxt3` e `examples/angular21` sono tradotti in inglese, con gli stessi numeri, versioni e riferimenti. Dipendenze, override e lockfile restano invariati; i testi italiani visibili all'utente non cambiano. Il pacchetto pubblicato non cambia comportamento. (CYJS-40)

## [0.14.24] - 2026-10-11

### Security

- **Strumenti di sviluppo aggiornati.** Lo strumento dei test e una libreria interna passano alle versioni senza falle note, e l'esempio SvelteKit usa la versione corretta della libreria dei cookie. Il pacchetto pubblicato non cambia comportamento.

## [0.14.23] - 2026-10-11

### Changed

- **Pubblicazione delle correzioni di sicurezza.** Questa versione porta sul registro dei pacchetti tutte le correzioni delle versioni da 0.14.12 a 0.14.22, che non erano ancora state pubblicate.

## [0.14.22] - 2026-10-10

### Sicurezza

- **Esempio Angular 21 su una versione sicura di @modelcontextprotocol/sdk.** Il progetto di prova `examples/angular21` impone @modelcontextprotocol/sdk 1.31.0 al posto della 1.30.0, che ha una falla nota. La chiede esatta @angular/cli 21.2.25 per il suo server MCP, usato solo in sviluppo; la 1.31.0 cambia solo il numero minore e dichiara le stesse dipendenze, quindi nel lockfile cambia solo questa libreria. La nota nel `package.json` dell'esempio spiega perché e dice di togliere l'override passando ad Angular 21.2.26, che chiede già la 1.31.0. Il pacchetto pubblicato non cambia. (CYJS-62)

## [0.14.21] - 2026-10-10

### Sicurezza

- **source-map-js aggiornata alla 1.2.2.** La libreria delle mappe dei sorgenti, usata solo dagli strumenti di sviluppo e di costruzione, passa dalla versione vulnerabile 1.2.1 alla 1.2.2 nel lockfile principale. Le librerie che la usano accettavano già la nuova versione, quindi niente override; nel lockfile cambia solo questa libreria. Il pacchetto pubblicato non cambia. (CYJS-61)

## [0.14.20] - 2026-10-10

### Sicurezza

- **Esempio Nuxt 3: cosa blocca già la falla degli include di simple-git 3.36.0.** Per la falla degli include della configurazione Git (GHSA-g4wm-2vf7-vfgr, CVE-2026-102826) nell'esempio `examples/nuxt3` la via principale è già chiusa: simple-git chiede il controllo a @simple-git/argv-parser, già forzato alla 2.0.1, che rifiuta sia gli include semplici sia quelli condizionali. Resta aperta solo la via secondaria (cambiare la cartella personale per far leggere a Git una configurazione scelta da altri), accettata perché il pannello di sviluppo gira solo sul computer di chi sviluppa. La libreria resta sulla 3.36.0, niente nuovi override e il lockfile resta invariato; la nota nel `package.json` dell'esempio lo spiega e dice quando aggiornare. Il pacchetto pubblicato non cambia. (CYJS-59)

## [0.14.19] - 2026-10-10

### Sicurezza

- **Esempio Nuxt 3: rischio accettato sulle falle di simple-git 3.36.0.** La libreria Git che @nuxt/devtools usa nel pannello di sviluppo dell'esempio `examples/nuxt3` resta sulla 3.36.0, come nell'esempio `examples/nuxt`: il controllo sulle opzioni Git pericolose si aggira con le opzioni lunghe abbreviate, gli include della configurazione Git non sono bloccati (GHSA-g4wm-2vf7-vfgr) e non è bloccata la configurazione dei trailer Git che fa eseguire un comando (GHSA-x6jw-m9v5-85vh); tutte e tre lasciano eseguire comandi. Le correzioni ci sono solo nella serie 4 (almeno la 4.0.1): nessuna versione stabile di @nuxt/devtools la accetta e forzarla rompe l'installazione; quindi niente override e il lockfile resta invariato. La nota nel `package.json` dell'esempio spiega falle, provenienza e quando ricontrollare. Il pacchetto pubblicato non cambia. (CYJS-58)

## [0.14.18] - 2026-10-10

### Sicurezza

- **Esempio Nuxt: rischio accettato anche sulla terza falla di simple-git 3.36.0.** La libreria Git che @nuxt/devtools usa nel pannello di sviluppo dell'esempio `examples/nuxt` non blocca la configurazione dei trailer Git che fa eseguire un comando, e così lascia eseguire comandi (GHSA-x6jw-m9v5-85vh). La correzione c'è solo nella 4.0.1: nessuna versione stabile di @nuxt/devtools accetta la serie 4 (solo la 4.0.0-beta non usa più la libreria, e anche l'ultima nuxt chiede ancora la serie 3 del pannello), e forzarla rompe l'installazione; quindi niente override e il lockfile resta invariato. La nota nel `package.json` dell'esempio ora copre tutte e tre le falle, con la versione che le corregge e quando ricontrollare. Il pacchetto pubblicato non cambia. (CYJS-57)

## [0.14.17] - 2026-10-10

### Sicurezza

- **Esempio Nuxt: rischio accettato anche sulla seconda falla di simple-git 3.36.0.** La libreria Git che @nuxt/devtools usa nel pannello di sviluppo dell'esempio `examples/nuxt` non blocca gli include della configurazione Git e così lascia eseguire comandi (GHSA-g4wm-2vf7-vfgr). La correzione c'è solo nella 4.0.0: nessuna versione stabile di @nuxt/devtools la accetta (solo la 4.0.0-beta non usa più la libreria, e anche l'ultima nuxt chiede ancora la serie 3 del pannello), e forzarla rompe l'installazione; quindi niente override e il lockfile resta invariato. La nota nel `package.json` dell'esempio ora copre entrambe le falle e dice quando ricontrollare. Il pacchetto pubblicato non cambia. (CYJS-56)

## [0.14.16] - 2026-10-10

### Sicurezza

- **Esempio Nuxt: rischio accettato su simple-git 3.36.0.** La libreria Git che @nuxt/devtools usa nel pannello di sviluppo dell'esempio `examples/nuxt` resta sulla 3.36.0: il controllo sulle opzioni Git pericolose si aggira con le opzioni lunghe abbreviate e lascia eseguire comandi. La correzione c'è solo nella 4.0.0, che @nuxt/devtools non accetta ancora e che, forzata, rompe l'installazione; quindi niente override e il lockfile resta invariato. La nota nel `package.json` dell'esempio spiega falla, provenienza e quando ricontrollare. Il pacchetto pubblicato non cambia. (CYJS-55)

## [0.14.15] - 2026-10-09

### Sicurezza

- **Esempio Nuxt: rischio accettato su node-forge 1.4.0.** La libreria di cifratura che listhen usa per i certificati del server locale di sviluppo, richiesta da @nuxt/cli e nitropack solo per il comando di sviluppo dell'esempio `examples/nuxt`, resta sulla 1.4.0: la verifica delle firme può accettare un certificato firmato in modo falso. Nessuna versione la corregge ancora, quindi un override non servirebbe e il lockfile resta invariato; la nota nel `package.json` dell'esempio spiega falla, provenienza e quando ricontrollare. Il pacchetto pubblicato non cambia. (CYJS-53)

## [0.14.14] - 2026-10-09

### Sicurezza

- **Esempio Nuxt 3: rischio accettato su braces 3.0.3.** La libreria che espande le graffe nei modelli di percorso, usata da Nuxt solo per cercare i file mentre prepara l'esempio `examples/nuxt3`, resta sulla 3.0.3: un modello molto annidato può bloccare quella preparazione. Nessuna versione la corregge ancora, quindi un override non servirebbe e il lockfile resta invariato; la nota nel `package.json` dell'esempio spiega falla, provenienza e quando ricontrollare, come per l'esempio Nuxt 4. Il pacchetto pubblicato non cambia. (CYJS-52)

## [0.14.13] - 2026-10-09

### Sicurezza

- **Esempio Nuxt 3 senza la versione vulnerabile di node-forge.** L'esempio `examples/nuxt3` sostituisce node-forge 1.4.0, che ha una falla nota senza ancora una versione corretta, con un pacchetto vuoto locale in `vendor/node-forge`. La libreria serviva solo a creare i certificati del server di sviluppo sicuro di Nuxt: il sostituto si carica senza errori e, se qualcuno lo usa davvero, si ferma con un messaggio che spiega perché. Il controllo automatico su Nuxt copia anche il sostituto. Il pacchetto pubblicato non cambia. (CYJS-54)

## [0.14.12] - 2026-10-09

### Sicurezza

- **Esempio Nuxt: rischio accettato su braces 3.0.3.** La libreria che espande le graffe nei modelli di percorso, usata da Nuxt solo per cercare i file mentre prepara l'esempio `examples/nuxt`, resta sulla 3.0.3: un modello molto annidato può bloccare quella preparazione. Nessuna versione la corregge ancora, quindi un override non servirebbe e il lockfile resta invariato; la nota nel `package.json` dell'esempio spiega falla, provenienza e quando ricontrollare. Il pacchetto pubblicato non cambia. (CYJS-51)

## [0.14.11] - 2026-10-09

### Corretto

- **Esempio Nuxt 3 su una versione sicura di @simple-git/argv-parser.** Anche l'esempio `examples/nuxt3` impone @simple-git/argv-parser 2.0.1 al posto della 1.1.1, che non bloccava alcune opzioni Git pericolose e lasciava passare l'esecuzione di comandi; l'esempio Nuxt 4 era già corretto. Arriva dal pannello di sviluppo di Nuxt, che non accetta ancora la 2: la nota nel `package.json` dell'esempio spiega falla e motivo. Il pacchetto pubblicato non cambia. (CYJS-50)

## [0.14.10] - 2026-10-09

### Corretto

- **Esempio Nuxt su una versione sicura di @simple-git/argv-parser.** L'esempio `examples/nuxt` impone @simple-git/argv-parser 2.0.1 al posto della 1.1.1, che non bloccava alcune opzioni Git pericolose e lasciava passare l'esecuzione di comandi. Arriva dal pannello di sviluppo di Nuxt, che non accetta ancora la 2: la nota nel `package.json` dell'esempio spiega falla e motivo. Il pacchetto pubblicato non cambia. (CYJS-49)

## [0.14.9] - 2026-10-09

### Corretto

- **Strumenti di sviluppo su una versione sicura di mysql2.** Il progetto impone mysql2 3.24.5 anche allo strumento di sviluppo di Prisma, che chiedeva la 3.15.3 con un difetto noto sulla gestione delle password: ora ne resta una sola copia, quella sicura. Il pacchetto pubblicato non cambia. (CYJS-48)

## [0.14.8] - 2026-10-09

### Corretto

- **Esempio dei database su una versione sicura di mysql2.** L'esempio `examples/node-database` impone mysql2 3.24.5 anche allo strumento di sviluppo di Prisma, che chiedeva la 3.15.3 con un difetto noto sulla gestione delle password: ora ne resta una sola copia, quella sicura. Il pacchetto pubblicato non cambia. (CYJS-47)

## [0.14.7] - 2026-10-09

### Corretto

- **Strumenti di sviluppo su una versione sicura di deepmerge-ts.** Il progetto impone deepmerge-ts 8.0.0 al posto della 7.1.5 richiesta dalla configurazione di Prisma, esposta a un esaurimento dello stack sui grafi ricorsivi (GHSA-ggr8-5vv4-36mx). Il pacchetto pubblicato non cambia. (CYJS-46)

## [0.14.6] - 2026-10-09

### Corretto

- **Esempio dei database su una versione sicura di deepmerge-ts.** L'esempio `examples/node-database` impone deepmerge-ts 8.0.0 al posto della 7.1.5 richiesta dalla configurazione di Prisma, esposta a un esaurimento dello stack sui grafi ricorsivi (GHSA-ggr8-5vv4-36mx). Il pacchetto pubblicato non cambia. (CYJS-45)

## [0.14.5] - 2026-10-09

### Corretto

- **Esempio Next 15 su una versione sicura di PostCSS.** L'esempio impone PostCSS 8.5.23 al posto della 8.4.31 richiesta da Next 15, che aveva un difetto noto. Il pacchetto pubblicato non cambia. (CYJS-43)

## [0.14.4] - 2026-10-09

### Corretto

- **Esempio Angular 21 senza piscina vulnerabile.** Il progetto di prova `examples/angular21` usa Angular CLI/build 21.2.25, che porta piscina 5.3.2 al posto della 5.2.0. Il pacchetto pubblicato non cambia. (CYJS-42)

## [0.14.2] - 2026-10-07

### Corretto

- **La 0.14.1 non è stata pubblicata.** Le destinazioni con schema (`http://host`, `location.origin`) tornano a essere riconosciute: confronto su schema, host e porta quando indicata.

## [0.14.1] - 2026-10-07

### Corretto

- **La 0.14.0 non è stata pubblicata.** Questa versione la sostituisce con lo stesso contenuto; il tetto del bundle è stato alzato di 0,5 KB per il nuovo mascheramento.

## [0.14.0] - 2026-10-07

### Modificato

- **Host fidati del trace confrontati per nome host.** Una stringa in `tracePropagationTargets` vale solo per quell'host o i suoi sottodomini (`example.com` copre `api.example.com`): prima bastava che l'indirizzo la contenesse. Le espressioni regolari non cambiano. (CYJS-63)

### Corretto

- **Token fuori da widget di aiuto e breadcrumb.** Il pulsante «Serve aiuto?» invia solo origine e percorso della pagina, il testo dei breadcrumb è mascherato come i messaggi d'errore e il cookie del replay è marcato `Secure`. (CYJS-63)

## [0.13.0] - 2026-10-05

### Added

- **Query lente e ripetute su Node.** Puoi osservare PostgreSQL e MySQL, anche tramite Drizzle e l'adapter PostgreSQL di Prisma. La raccolta è facoltativa, oscura i dati delle query e si disattiva senza chiudere le connessioni dell'applicazione.

## [0.12.0] - 2026-10-04

### Aggiunto

- **Integrazioni per i framework web.** Adapter opzionali per React, Next.js, Vue, Nuxt, Angular, Svelte e SvelteKit collegano errori e richieste al contesto applicativo. Le guide indicano versioni collaudate e limiti.

- **Pulsante «Serve aiuto?»** — una riga di `<script>` aggiunge al sito un pulsante con il modulo per scrivere al team. È un file a parte: chi non lo usa non scarica niente in più. (CYRA-942)

### Corretto

- **Cause degli errori conservate.** Gli eventi includono fino a dieci eccezioni concatenate, con dati sensibili oscurati e protezioni contro cicli e proprietà illeggibili.

## [0.11.4] - 2026-10-01

### Corretto

- **Pubblicazione riparata.** La 0.11.3 non è arrivata su npm: questa versione contiene le stesse modifiche.

## [0.11.3] - 2026-10-01

### Modificato

- **Manutenzione interna.** La pubblicazione su npm non usa più un token salvato e le dipendenze di sviluppo sono aggiornate. Per chi usa la libreria non cambia niente. (CYJS-39)

## [0.11.2] - 2026-09-07

### Sicurezza

- **Una chiave d'accesso finita dentro a un messaggio ora sparisce per intero** — se un errore
  riportava la riga di accesso, la libreria ne nascondeva solo l'inizio e lasciava visibile la parte
  che conta. Ora di quella riga resta il solo nome, e il resto del messaggio si legge come prima
  (CYJS-38).

- **Un rimbalzo del server non può più far viaggiare in chiaro la chiave d'accesso** — se l'indirizzo
  di raccolta rispondeva «vai qui», la libreria lo seguiva anche verso una connessione non protetta.
  Ora rimbalzi e catene di rimbalzi si accettano solo entro l'indirizzo di partenza (CYJS-37).

## [0.11.1] - 2026-09-03

### Sicurezza

- **Chiusa una falla in una libreria usata solo per le prove** — il componente che controlla i
  formati durante lo sviluppo si appoggiava a una versione che poteva essere ingannata su quale
  indirizzo stesse leggendo. Non finiva nel pacchetto che si installa, ma ora è aggiornato lo stesso.

## [0.11.0] - 2026-09-03

### Aggiunto

- **Le applicazioni JavaScript dicono quali funzioni vengono davvero usate** — con `usageEnabled` la
  libreria manda ogni 5 minuti l'elenco di route, job e chiavi eseguite, e il progetto compare nella
  pagina d'uso e nella riga di comando. Solo lato server: nel browser resta spenta e lo dice.

### Modificato

- **La presentazione della libreria non promette più di fare le stesse cose delle altre** — si
  diceva identica alle librerie Ruby e Dart, ma alcune funzioni esistono solo in una o due. Ora
  rimanda alla tabella unica che dice quale libreria sa fare cosa, e da quale versione.

### Sicurezza

- **Solo versioni definitive arrivano a chi installa la libreria** — chi la installa senza chiedere
  un numero preciso riceve quella che il magazzino pubblico segna come «l'ultima buona». Finora
  bastava un'etichetta di prova per far partire la pubblicazione vera: il commento sopra al lavoro
  diceva «solo versioni definitive», la regola scritta accettava qualunque etichetta che cominciasse
  per `v`. Roba non ancora verificata sarebbe finita in casa di chi usa la libreria, marcata come
  l'ultima buona — non è mai successo solo perché i rilasci li ha sempre fatti una persona a mano.
  Adesso la pubblicazione si ferma prima di partire quando l'etichetta non è definitiva.

### Corretto

- **Il numero del rilascio e quello dentro il pacchetto non possono più divergere** — erano tre
  numeri diversi che nessuno metteva a confronto: quello dell'etichetta, quello scritto nel
  pacchetto, e quello che la libreria dichiara di essere quando ci manda un errore. Un rilascio
  poteva chiamarsi 0.12.0 e pubblicare 0.11.0 senza che nulla diventasse rosso; e se 0.11.0 era già
  uscita, il magazzino rifiutava il rilascio buono lasciando il lavoro a metà. Il terzo numero, se
  restava indietro, faceva comparire nel pannello gli errori dei siti sotto una versione che non era
  quella vera. Adesso il rilascio si ferma prima di pubblicare quando i tre numeri non coincidono, e
  dice quale non torna.

## [0.10.0] - 2026-08-16

### Aggiunto

- **Velocità percepita dai visitatori veri (CYJS-12, CYJS-28)** — con `trackWebVitals: true` l'SDK
  misura sul browser di chi visita il sito le tre cose con cui Google giudica la velocità: quanto ci
  mette a comparire il contenuto principale (LCP), quanto la pagina si sposta sotto gli occhi mentre
  carica (CLS) e quanto tarda a rispondere quando la si tocca (INP). Insieme arrivano le due misure
  che spiegano un caricamento lento: quanto ci mette il server a rispondere (TTFB) e quando compare
  il primo pezzo di pagina (FCP). Finora quei numeri si potevano solo stimare in laboratorio: adesso
  arrivano dalle visite vere, pagina per pagina.

  A misurarli è **la libreria di Google**, la stessa che sta dietro ai dati che Google pubblica sui
  siti: così i numeri di CloseYourIt e quelli che si leggono altrove parlano della stessa cosa e si
  possono mettere una accanto all'altra. È l'**unica** libreria esterna che l'SDK si porta dietro, ed
  è dentro il pacchetto: chi lo installa non deve aggiungere nulla.

  Le misure partono **tutte insieme, in un invio solo**, quando la pagina esce di scena: prima di
  allora sono provvisorie — il contenuto principale può ancora essere superato da uno più grande, gli
  spostamenti possono ancora aumentare. Un valore per metrica a caricamento: una seconda uscita non
  produce un doppione. Quello che arriva in ritardo, dopo che l'invio è già partito, viene mandato
  entro cinque secondi invece di restare fermo in attesa di un'uscita di pagina che potrebbe non
  arrivare mai. Nel corpo viaggiano il nome del sito, il percorso della pagina (**mai** la query, che
  può contenere dati riservati), il tipo di navigazione, l'ambiente e la versione: nessun dato che
  identifichi il visitatore. Il giudizio buono/da migliorare/scarso non viene mandato — lo calcola
  CloseYourIt, così un SDK vecchio non può dipingere di verde ciò che oggi è rosso.

  `webVitalsSampleRate` (default `1.0`, indipendente dal campionamento degli errori) permette di
  raccoglierne solo una parte, e decide sul **caricamento intero**: le misure di una pagina partono
  tutte o nessuna, altrimenti i percentili di metriche diverse verrebbero da insiemi di pagine
  diversi e non sarebbero più confrontabili tra loro.

  **Dove il browser non sa misurare, non succede nulla**: la metrica che manca semplicemente non
  arriva, le altre partono lo stesso e il resto dell'SDK non cambia comportamento.

  **Nota per chi pubblica questa versione.** Lo snippet che i siti caricano da CDN non è fissato a
  una versione: appena questa esce, entro pochi giorni arriva da sola su tutti i siti che hanno
  installato CloseYourIt. Le misure hanno quindi bisogno che la parte che le riceve sia **già
  attiva** in produzione (CYRA-538), altrimenti i browser dei visitatori manderebbero dati verso una
  porta chiusa. Prima quello, poi la pubblicazione.

- **Risorse che non caricano e policy del browser che bloccano (CYJS-12)** — con
  `captureResourceErrors: true` l'SDK segnala i guasti che nessun errore JavaScript racconta: uno
  script o un foglio di stile che non arriva, un'immagine che non carica, una regola di sicurezza
  della pagina (CSP) che blocca qualcosa che serviva. Prima quei fallimenti erano invisibili: il
  browser li segnalava e basta, e la pagina restava rotta senza che nessuno lo sapesse.

  Arrivano insieme agli altri errori, ma come **avvisi** e non come errori dell'applicazione: una
  risorsa bloccata è quasi sempre ambiente o terze parti — un blocco pubblicità, una CDN
  irraggiungibile — e trattarla da guasto riempirebbe gli avvisi di rumore che nessuno può
  correggere. Gli indirizzi viaggiano **sempre senza query string**, che nelle CDN porta le firme di
  accesso. Il tetto è di **dieci segnalazioni per pagina** e la stessa risorsa che continua a fallire
  ne vale una sola: una CDN giù fa fallire ogni immagine del catalogo, e le prime dicono già tutto.

### Cambiato

- **Il peso dello snippet ha un tetto, e la CI lo fa rispettare (CYJS-28)** — lo `<script>` che i
  siti caricano da CDN lo scarica ogni visitatore di ogni sito che ha installato CloseYourIt, anche
  chi delle novità non usa niente. Da ora la sua dimensione massima è scritta nel progetto e viene
  verificata a ogni modifica: se una nuova funzione lo fa crescere oltre il tetto, il controllo si
  ferma e la crescita va discussa invece di passare inosservata. Con le misure di velocità dentro,
  lo snippet pesa circa 18 KB compressi.

## [0.9.0] - 2026-08-15

### Cambiato

- **L'ultima misura parte anche quando la scheda si chiude (CYJS-29)** — chiudendo la pagina l'invio in
  corso poteva non arrivare mai, soprattutto su iPhone: la richiesta veniva abbandonata a metà e quel
  dato spariva senza lasciare traccia. Da `pagehide`/`visibilitychange(hidden)` in poi gli invii del
  browser passano dal canale che i browser tengono in vita apposta per questo momento
  (`navigator.sendBeacon`), quindi l'ultima misura, l'ultimo log e l'ultimo errore arrivano lo stesso.

  Vale solo per il browser autenticato con la **DSN public key**: quel canale non può portare header, e
  con il bearer l'invio partirebbe senza credenziale — lì resta il `fetch` di prima. Il body viaggia
  come `text/plain` (lo stesso JSON di sempre): con `application/json` il browser anteporrebbe una
  richiesta di permesso che, a pagina in chiusura, non fa in tempo a completarsi. Dove il canale non
  c'è o rifiuta il payload perché la sua quota è esaurita, si ripiega sul `fetch` di prima: un invio
  senza garanzie è meglio di un invio perso.

  **Nota per chi legge i contatori**: il browser non restituisce una risposta per questi invii. Contano
  come `sent` nel senso di "presi in carico dal browser" e il loro evento diagnostico `send` non porta
  uno `status`. Al ritorno in primo piano (ripristino da bfcache) si torna al `fetch`, che la risposta
  la dà.

- **Le registrazioni delle sessioni mascherano anche il testo mostrato dalla pagina (CYJS-15)** — prima
  il masking di default copriva solo quello che l'utente digitava nei campi. In un gestionale i dati
  sensibili sono soprattutto testo che la pagina mostra — nomi di clienti, pratiche, importi — e finiva
  registrato in chiaro. Ora `replayMaskTextSelector` vale `'*'` per default, il selettore che in rrweb fa
  matchare ogni elemento: tutto il testo risulta coperto.

  **Cambio di comportamento.** Chi vuole vedere in chiaro una parte della pagina deve dichiararlo,
  passando un selettore più stretto (`replayMaskTextSelector: '.riservato'` maschera solo quella parte).
  Chi già passava un selettore proprio non è toccato: il valore esplicito vince sul default.

  Il motivo per cui il default va dalla parte stretta: una registrazione non si corregge a posteriori,
  un dato finito in chiaro si toglie solo cancellando l'intera registrazione.

### Infrastruttura

- **Toolchain aggiornata e catena di build irrobustita (CYJS-14)** — le action della CI non girano più su
  un tag mobile (`@v6`) ma sullo SHA del commit, con la versione nel commento: un tag può essere spostato
  su codice mai revisionato, e qui accanto gira il job che pubblica su npm. Il `GITHUB_TOKEN` parte in
  sola lettura per tutti i job e solo la pubblicazione alza i permessi, per il solo OIDC. A ogni run un
  audit verifica le dipendenze che finiscono davvero nel pacchetto pubblicato (`pnpm run audit:prod`).
- **Aggiornamenti separati e verificabili (CYJS-14)** — Dependabot sorveglia sia le action della CI sia i
  pacchetti npm: minor e patch arrivano raggruppate, ogni salto maggiore resta una richiesta a sé, da
  valutare con i suoi gate verdi. Un contratto in test blinda la regola, così un bump collettivo non può
  rientrare di nascosto.
- **Strumenti di sviluppo aggiornati un salto per volta (CYJS-14)** — `@types/node` alla 24 (la major del
  Node in uso, non l'ultima pubblicata: i tipi devono descrivere il runtime che gira davvero), `jsdom`
  alla 29 e `vitest` con `@vitest/coverage-v8` alla 4. Nessun effetto sul pacchetto pubblicato: sono gli
  strumenti con cui viene costruito e verificato. `typescript` resta sulla 5 perché la 7 rompe la
  generazione dei tipi dentro `tsup`; il motivo è annotato dove serve, così chi ci riprova non riparte da
  zero. Un test in più rifiuta gli aggiornamenti che chiedono un Node più nuovo di quello della
  toolchain: prima quel disallineamento si scopriva solo a CI rotta.

## [0.8.0] - 2026-08-06

### Aggiunto

- **Visibilità degli eventi scartati dallo SDK (CYJS-9)** — quando un evento non parte (coda piena,
  `beforeSend` che lo scarta o solleva, campionamento, timeout, `4xx`/`429`/`5xx`, rete assente)
  l'applicazione può ora diagnosticarlo senza generare nuova telemetria. `getStats()` espone, oltre agli
  aggregati (`enqueued`/`sent`/`dropped`/`failed`/`timeout`), la ripartizione `reasons` per motivo; la
  nuova opzione `onDiagnostic(event, details)` notifica in tempo reale ogni tappa
  (`enqueue`/`send`/`drop`/`timeout`/`shutdown`) con il motivo. L'hook è process-local e **non ricorsivo**
  (mentre gira, le API di cattura sono no-op e i diagnostici annidati soppressi), i `details` non
  contengono mai payload né segreti (`error` è il solo nome della classe). Inoltre un `beforeSend` che
  solleva non propaga più: l'errore è assorbito e contabilizzato come scarto (motivo `error`).
- **Propagazione del contesto di tracing W3C (CYJS-13)** — lo SDK legge e propaga gli header standard
  `traceparent`/`tracestate` (W3C Trace Context), così servizi e browser che usano il tracing distribuito
  mantengono la correlazione senza un protocollo proprietario. `continueTrace(carrier)` adotta un trace
  context in ingresso (header di richiesta server/SSR, un `Headers` o un getter): il suo trace-id diventa
  il `trace_id` di correlazione — errori, log e metriche si agganciano al trace distribuito — e
  parent/sampling/tracestate/baggage sono conservati per la ri-propagazione. `getTraceHeaders(target?)`
  restituisce gli header da iniettare in una richiesta in uscita, ma **solo verso destinazioni fidate**:
  la nuova opzione `tracePropagationTargets` (allowlist di stringhe o RegExp) più il same-origin nel
  browser. Verso ogni altra destinazione ritorna `{}` — nessun header — così il trace interno e il
  baggage (potenziale PII) non raggiungono host non fidati. Header assente o malformato: no-op, si
  mantiene il trace corrente. Isomorfo browser/Node, zero dipendenze.

## [0.7.1] - 2026-08-06

### Corretto

- **Riconfigurazione dell'SDK a caldo senza riavviare Node (CYJS-8)** — richiamare `init` con opzioni
  diverse (endpoint, token, release, …) veniva ignorato finché l'SDK era attivo: la nuova configurazione
  non entrava mai in uso. Ora `init` riconfigura a caldo: smonta gli handler del client precedente e ne
  avvia flush+close in background (gli eventi già in coda partono verso la vecchia configurazione;
  `flush()`/`close()` attendono anche quella chiusura, così non si perde nulla all'uscita del processo),
  trasferisce lo scope corrente (trace_id, utente, tag, breadcrumb) al nuovo client e mette in uso la
  nuova config — senza `close()` manuale e senza lasciare handler duplicati. Con opzioni equivalenti
  resta un no-op idempotente, anche a client disabilitato (confronto sulle opzioni risolte, `beforeSend`
  per reference).

## [0.7.0] - 2026-08-01

### Aggiunto

- **Budget in byte e troncamento per canale prima dell'invio (CYJS-10)** — ogni canale ha ora un tetto di
  byte e una strategia di troncamento propria, applicata prima della spedizione. Il budget di `message` e
  `value` conta i byte **dopo** l'escaping JSON (`"`→`\"`, newline→`\n`, control→`\u00XX`), non quelli
  della stringa grezza: prima log ed eventi pieni di virgolette potevano restare sopra soglia. Una rete di
  sicurezza comune a tutti i canali tronca le stringhe non identitarie e rimuove i valori custom residui —
  anche quelli iniettati da `beforeSend` — garantendo che il payload rientri sempre nel budget.

### Corretto

- **Il contesto non si mescola più fra richieste concorrenti su Node (CYJS-7)** — su Node più richieste
  condividevano un solo holder di scope: utente, tag, request, `trace_id` e breadcrumb di una richiesta
  finivano negli eventi di un'altra. Ora c'è un `AsyncLocalStorage` lato server (import browser-safe) con
  le API `runWithScope`/`withScope`. La guida Node e l'esempio Nitro non mostrano più l'anti-pattern sullo
  scope condiviso: si avvolge l'handler con `runWithScope` e si cattura negli hook globali con `withScope`.
- **Versione dell'SDK allineata al pacchetto** — la costante interna era rimasta a `0.6.0` mentre il
  pacchetto era alla `0.6.1`.

### Infrastruttura

- **Smoke test del pacchetto npm come consumatore reale (CYJS-11)** — la CI ora costruisce, impacchetta e
  consuma davvero il pacchetto (require CJS, import ESM, load del bundle IIFE) con il Node della matrice,
  tenendo separata la toolchain dal consumatore: `pnpm` gira sul Node pinnato, il consumo sul Node minimo
  supportato. Senza questa separazione il job sarebbe fallito sempre, bloccando ogni release.
- **E2E non mockato di tutti i canali browser (CYJS-6)** — con la DSN public key vengono inviati per
  davvero errori, messaggi, log, metriche, pageview e replay verso un backend di prova, i cui status attesi
  sono derivati dalle fixture del contratto invece che ricopiati a mano: se il contratto documentato cambia,
  il test diventa rosso.

## [0.6.1] - 2026-07-11

### Aggiunto

- **Auto-detect della release Node-side (CYJS-5)** — su runtime Node reale (SSR/backend) l'SDK
  rileva ora da solo la `release` dal deploy, in **parità tag-first con la gem Ruby**: prima il tag
  semver (`APP_GIT_TAG` poi `GIT_TAG`, accettati solo se semver validi), poi lo SHA del deploy
  (`KAMAL_VERSION` poi `GIT_SHA`) come fallback. Una `release` passata nelle options ha **sempre** la
  precedenza. Il rilevamento è gated su Node reale (`process.versions.node`, esclude window/jsdom):
  nel **browser** non c'è alcun accesso alle variabili di processo — la `release` va passata
  esplicita (build-time inject). SDK isomorfo: solo lettura di ENV, **mai** un subprocess git.

## [0.6.0] - 2026-07-10

### Sicurezza

- **Il bearer segreto `cyi_` non finisce mai più nel browser (CYJS-1)** — `token` è ora una
  credenziale **SERVER-ONLY** (piena potenza ingest + read). Nel browser l'SDK autentica con la nuova
  opzione **`publicKey`** (DSN public key, non segreta) via `?sentry_key=` sul drop-in Sentry
  `POST /api/{projectId}/store` per gli errori/messaggi; il bearer non viene **mai** inviato dal
  browser. Passando nel browser solo il bearer segreto, l'SDK resta no-op (con `console.warn`) invece
  di esporlo nel bundle/tab Network. README riconciliati (rimossa l'indicazione "può stare nel bundle").

### Aggiunto

- **Opzione `publicKey`** (DSN public key) — credenziale **browser-safe**. Node/SSR continua a usare
  `token` (bearer) sui path `/api/v1/projects/*`; il browser usa `publicKey` (eventi al drop-in
  `/store`, gli altri canali sui path v1 con `?sentry_key=`).

### Modifiche che rompono la compatibilità

- **Browser**: la sola `token` (bearer `cyi_`) non abilita più l'SDK nel browser — serve `publicKey`.
  Aggiornare i progetti browser per fornire la DSN public key. Node/SSR invariato.

### Corretto

- **`repeated_http`: conteggio visibile in UI (CYJS-2)** — il verdetto `repeated_http` emette
  ora il campo wire **`query_count`** invece di `count_in_request`. Prima il conteggio delle richieste
  ripetute dal browser era invisibile nel Monitor (colonna `—`), perché il reader Rails
  (`occurrence_query_count`) e l'SDK dart leggono `query_count`: un solo nome di campo wire cross-SDK.
- **DX misconfig**: `init()` con una config incompleta (token/projectId mancante) ora emette un
  `console.warn` esplicito ("SDK disabilitato: … — nessun evento verrà inviato") invece di restare un
  no-op totalmente silenzioso. Non avvisa quando la disabilitazione è voluta (`enabled: false`).
- **DX diagnostica**: su risposta non-2xx il log di debug include ora il codice d'errore `R…` e il
  messaggio dall'envelope del backend (es. `R422-INGEST-001: Evento malformato`), non solo lo status.

## [0.5.0] - 2026-07-08

### Aggiunto

- **Metadata comportamentale nel session replay** — ogni chunk porta ora `path` (pathname corrente al
  flush, senza query string) e `user` (id da `setUser`, opzionale). Alimentano la galleria "come si
  comportano gli utenti" nel Monitor (pagine visitate, sessioni per utente). Additivo e retro-compatibile:
  i chunk senza `path`/`user` restano validi. Nuovo getter `Scope#userId`.

## [0.4.0] - 2026-07-07

### Aggiunto

- **Session replay (opt-in `replay`, default `false`)** — registra la sessione con rrweb e invia i
  chunk a `POST /api/v1/projects/{projectId}/replays`. Recorder in
  `integrations/browser/replay.ts` (twin di `installPageviews`): buffer degli eventi rrweb, flush
  periodico (`replayFlushIntervalMs`, default 5000) + su `pagehide`/`visibilitychange(hidden)` + a
  soglia di buffer. Passa da `enqueue` → soggetto a `beforeSend` e ai contatori come gli altri invii.
- **Sessione di replay longeva** (`session.ts`) — id opaco (no PII) stabile per l'intera
  sessione-browser via `sessionStorage` (`cyi_replay`), più longevo del `trace_id` per-pagina;
  fallback in-memory se lo storage non è disponibile.
- **Correlazione errore ↔ replay** — gli errori/messaggi JS portano l'id in
  `contexts.replay.replay_id` (nuovo `Scope.replaySessionId`); per gli errori server il recorder
  scrive un cookie di sessione `cyi_replay` (`SameSite=Lax`) che le richieste same-origin trasportano
  al backend. Facade `getReplaySessionId()`.
- **Privacy** — masking di default: `replayMaskAllInputs` (default `true`), più `replayBlockSelector`
  e `replayMaskTextSelector` (rrweb) per bloccare/mascherare elementi sensibili. rrweb NON è una
  dipendenza: il recorder usa il globale `window.rrweb` (build UMD caricata dalla pagina), il core
  resta zero-dep.

### Modificato

- Allineata `SDK_VERSION` (`version.ts`) a `package.json` (era ferma a `0.2.0`).

## [0.3.0] - 2026-07-03

### Aggiunto

- **`captureEvent(name, overrides?)`** — invia un custom event (goal/conversione analytics) con il campo
  `name` valorizzato; no-op fuori dal browser, pre-init o senza nome.
- **Payload pageview esteso** — `buildPageview` estrae le 5 chiavi UTM (aggiunte `utm_term`/`utm_content`)
  e include `screen_width` dalla viewport (il server la classifica in `screen_class`, mai il valore raw).
  Additivo: gli SDK a 3 chiavi restano compatibili.

## [0.2.0] - 2026-07-02

### Aggiunto

- **Pageview tracking (web analytics)** — opzione `trackPageviews` (default `false`, opt-in):
  pageview all'`init()` e a ogni navigazione SPA (patch `history.pushState`/`replaceState` +
  `popstate`) con **dedup sul pathname** (hash change e `replaceState` ripetuti sullo stesso path
  non emettono, semantica Plausible). Endpoint `POST /api/v1/projects/{projectId}/pageviews`.
- `capturePageview(overrides?)` sulla facade (anche `window.CloseYourIt.capturePageview` via IIFE)
  per pageview manuali; i pageview **non** sono soggetti a `sampleRate` (sono il dato, non un campione).
- Payload privacy-first: `hostname` + `pathname` (mai la query string), `document.referrer`
  (omesso se vuoto), **UTM estratti client-side** (solo `utm_source`/`utm_medium`/`utm_campaign`),
  `event_id` UUID per idempotenza, `occurred_at` ISO. Nessun dato identificante nel body: IP e
  User-Agent li consuma il server dalla richiesta (visitor hash cookieless a salt giornaliero).

### Modificato

- Refactor interno `subscribeNavigation` (`integrations/browser/navigation.ts`): un solo
  monkey-patch di `history` condiviso tra breadcrumb di navigazione e pageview (patch installato
  al primo subscriber, ripristinato all'ultimo unsubscribe).

## [0.1.0] - 2026-07-02

### Aggiunto

- SDK `@bussolabs/closeyourit-js` **isomorfo browser + Node 20+** (TypeScript, zero dipendenze
  runtime). Contratto wire identico a `closeyourit-ruby` e `closeyourit-dart` (formato Sentry,
  campi `snake_case`, `POST /api/v1/projects/{projectId}/{events,metrics,logs}` con
  `Authorization: Bearer cyi_…`).
- **Cattura errori**: `captureException` e `captureMessage`; nel browser gestori globali
  `error` + `unhandledrejection` (via `addEventListener`, non clobberano handler esistenti); su
  Node `uncaughtException`/`unhandledRejection` con flush (timeout 2s) e uscita col codice 1 se
  non ci sono handler utente (semantica crash di default preservata). `excludedExceptions` per
  nome; dedup a identità d'oggetto (`WeakSet`, mark-before-sampling) + finestra temporale.
- **Log strutturati**: `log(level, message, attributes, logger)` e `logger` nominato
  (`debug/info/warn/error/fatal`, `warn`→`warning`), buffer batch (50/5s, chunk ≤ 1000) con flush
  automatico su timer, `pagehide`/`visibilitychange(hidden)` (browser, `fetch(keepalive)` sotto
  la quota 64 KB) e `beforeExit`/`SIGTERM` (Node). Gating `logsEnabled`/`logsMinLevel`/
  `logsSampleRate`.
- **Metriche**: `measure(label, body)` (sync/async, ritorna il valore, metrica anche su throw) →
  `slow_method` oltre `slowMethodThresholdMs`; `arguments` opt-in con
  `captureMethodArguments` (scrubati, troncati). Mai campionate.
- **Performance issues (opt-in `detectPerformanceIssues`)**: `slow_external_http` (fetch/XHR
  esterna oltre soglia, path templatizzato `<uuid>`/`<n>`), `repeated_http` (stessa richiesta ≥ N
  volte in finestra — l'N+1 del client), `jank` (long task via `PerformanceObserver`, di fatto
  Chromium-only).
- **Scope**: `setUser`/`setTag`/`setTags`/`setExtra`/`setContext`/`setTraceId`/`setRequest` +
  `clearScope`; `trace_id` di pagina generato all'init per correlare errori, log e metriche;
  request context automatico nel browser (URL senza query, User-Agent, referrer).
- **Breadcrumb** automatici con interruttori granulari (`autoBreadcrumbs`): click, navigazione
  (`pushState`/`replaceState`/`popstate`), `console.warn`/`console.error`, `fetch`/XHR (marcatura
  `slow_external_http` sulle esterne lente). URL privati di query e hash.
- **Privacy**: policy `sendPii` (default off: `user`→`{id}`, URL senza query, referrer
  strippato), scrubber PII ricorsivo (denylist superset del backend, include `email`), hook
  `beforeSend` su ogni payload.
- **Affidabilità**: transport fire-and-forget che non solleva mai, coda bounded (`maxQueue`) con
  drop e contatori `getStats()`; su Node redirect POST seguiti a mano (max 2, solo same-host o
  www-swap: il Bearer non esce mai verso host terzi) e `User-Agent: closeyourit-js/{versione}`.
- **Distribuzione**: build ESM + CJS + tipi per bundler/npm, e IIFE minificato
  (`window.CloseYourIt`) per `<script>` — ~7 KB gzip.
