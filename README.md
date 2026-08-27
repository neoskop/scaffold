# @neoskop/scaffold

Installiert Dateien aus einem Git-Repo in ein Projekt — und hält sie aktuell, ohne
Projekt-Anpassungen zu überschreiben. Jede Datei wird beim Update per 3-Way-Merge
(`git merge-file`) gegen den Stand gemergt, der beim letzten Mal installiert wurde.

Ohne Runtime-Dependencies: `node:*` plus `git` auf dem Host.

## Installieren

Im Projekt-Root:

```bash
pnpm dlx @neoskop/scaffold@latest init neoskop/devcontainer-scaffold@v0.1.0
```

Existiert schon eine handkopierte Version dessen, was das Template mitbringt:

```bash
pnpm dlx @neoskop/scaffold@latest init <repo> --adopt
```

`--adopt` lässt jede vorhandene Datei unangetastet und schreibt nur den Zustand. Die
Abweichungen tauchen beim nächsten `update` als normaler Merge auf, statt verloren zu gehen.

## Die Repo-Spec

Ein Argument, sechs Formen. Die Form wird am Anfang der Zeichenkette entschieden, nicht am
Inhalt — sonst wäre das `@` in `git@github.com:…` nicht von einem Tag zu unterscheiden.

| Spec | Bedeutung |
| --- | --- |
| `org/repo` | GitHub über SSH (`git@github.com:org/repo.git`), Default-Branch |
| `org/repo/feature/x` | GitHub, Branch `feature/x` (alles nach dem zweiten `/` ist der Branch) |
| `org/repo@v1.2.0` | GitHub, Tag |
| `org/repo#a1b2c3d` | GitHub, Commit |
| `git@host:org/repo.git` | beliebiges SSH-Remote |
| `https://host/org/repo.git` | beliebiges HTTPS-Remote |
| `./pfad/zum/repo` | lokales Git-Repo |

Die letzten drei Formen nehmen `#<ref>` zum Pinnen — `git@host:o/r.git#v1.2.0`. Nur die
GitHub-Kurzform kennt `/`, `@` und `#` als Trenner.

**Für alles Automatisierte auf einen Tag oder Commit pinnen.** Ein Default-Branch heißt, dass
sich der Code, den `init` ausführt (siehe Hooks), unter einem ändern kann.

Ein lokaler Pfad ist gleichzeitig der Weg ohne Netz: `init ./mein-template` braucht kein Remote.

## Aktualisieren

```bash
pnpm dlx @neoskop/scaffold@latest update                    # alle Scaffolds
pnpm dlx @neoskop/scaffold@latest update devcontainer       # nur eines
pnpm dlx @neoskop/scaffold@latest update --ref v1.3.0       # auf einen anderen Stand
pnpm dlx @neoskop/scaffold@latest update --check            # nichts schreiben, nur melden
```

Pro Datei:

| Fall | Ergebnis |
| --- | --- |
| lokal unverändert | wird durchgezogen (`updated`) |
| lokale Änderung an anderer Stelle | zusammengeführt (`merged`), beide Änderungen bleiben |
| lokale Änderung an derselben Stelle | Konfliktmarker im File, Exit-Code 1 (`conflict`) |
| bereits auf dem neuen Stand | `unchanged` |
| lokal gelöscht | wird wiederhergestellt (`restored`) |
| upstream gelöscht, lokal unverändert gegenüber der Basis | wird gelöscht (`removed`), leere Verzeichnisse aufgeräumt |
| upstream gelöscht, lokal geändert | bleibt liegen (`kept`) und gehört ab jetzt dem Projekt |
| vom `exclude`-Hook ausgenommen | wird nicht installiert (`excluded`), siehe [Dateien ausnehmen](#dateien-ausnehmen) |
| Binärdatei, beide Seiten geändert | `conflict` — es gibt nichts zu mergen |

**Nichts wird still überschrieben.** Konflikte löst man wie einen Git-Merge-Konflikt
(`<<<<<<<` / `|||||||` / `=======` / `>>>>>>>`, mit `--diff3` inklusive Basis-Hunk).

Exit-Codes: `0` in Ordnung · `1` unter `--check` nicht aktuell, oder ungelöste Konflikte ·
`2` Fehler.

## Ein Template-Repo bauen

```
template/                 wird 1:1 ins Zielprojekt kopiert
  .devcontainer/…           → <projekt>/.devcontainer/…
  .pnpmfile.mjs             → <projekt>/.pnpmfile.mjs
scaffold.hooks.mjs        optional, siehe unten
README.md                 was das Scaffold tut
```

`template/` ist ein Abbild dessen, was im Zielprojekt landen soll — kein Mapping, keine
Platzhalter, keine Variablen-Substitution. Das Ausführbar-Bit kommt aus dem Repo: was `git` als
`100755` führt, landet als `0755`. Leere Verzeichnisse kann git nicht führen; wer eines braucht,
legt eine `.gitkeep` hinein.

Symlinks und alles andere, was keine reguläre Datei ist, werden übersprungen und gemeldet.

## Hooks

Kopieren deckt fast alles ab. Was es nicht abdeckt: Einträge in Dateien, die dem *Projekt*
gehören und nicht dem Scaffold — eine Zeile in `.gitignore`, ein Server in `.mcp.json`. Ein
`scaffold.hooks.mjs` im Wurzelverzeichnis des Template-Repos (nicht in `template/`) kann das
übernehmen. Plain ESM, benannte Exports, alle optional:

| Export | Wann |
| --- | --- |
| `preInit` | vor dem ersten Schreiben. Wirft er, wird nichts installiert (Exit 2) |
| `postInit` | nach der Installation |
| `preUpdate` / `postUpdate` | dasselbe für `update` |
| `preSync` / `postSync` | direkt um das Schreiben der Dateien herum — bei `init` **und** bei `update` |
| `exclude` | wird *gefragt*, nicht ausgeführt: welche Dateien gehören nicht in dieses Projekt |

Die Reihenfolge ist damit für beide Kommandos dieselbe:

```
init:     preInit    → preSync → [Dateien schreiben] → postSync → postInit
update:   preUpdate  → preSync → [Dateien schreiben] → postSync → postUpdate
```

`preSync`/`postSync` sind die Stelle für alles, was in beiden Fällen gleich läuft — sonst
müsste dieselbe Funktion zweimal exportiert werden, einmal für `init` und einmal für `update`.
Ein `pre*`-Hook wirft und bricht ab, bevor irgendetwas geschrieben ist (Exit 2); ein
`post*`-Hook wirft, nachdem die Dateien liegen — das wird gemeldet und endet in Exit 1, der
Scaffold bleibt eingetragen und mit einem `update` reparierbar.

```js
export function postInit(ctx) {
    // ctx: { cwd, templateDir, repoDir, name, ref, commit, previousCommit, check, files, log }
    ctx.log('added', '.gitignore', 'required by the template');
    if (!ctx.check) writeFileSync(join(ctx.cwd, '.gitignore'), 'node_modules\n');
}
```

`ctx.log(kind, path, detail?)` trägt eine Zeile in den Report ein. **Der Kind ist nicht
Deko:** `added`, `updated`, `merged`, `removed`, `restored` und `conflict` sind das, woraus
`--check` seinen Exit-Code bildet. Ein Hook, der nur Strings ausgibt, lässt die CI grün werden,
während die Dateien, die er verwaltet, veraltet sind.

Zwei Regeln für jeden Hook:

1. **Idempotent.** `--check` ruft denselben Code auf und zählt, was er meldet. Wer bei jedem
   Lauf eine Änderung meldet, macht die CI dauerhaft rot.
2. **Kein Write, wenn `ctx.check` gesetzt ist.** Das ist der Dry-Run.

Die CLI installiert für Hooks nichts und ruft nie einen Paketmanager auf — `node:`-Builtins,
sonst nichts. Wer Dependency-Arbeit braucht, macht sie in einem `post*`-Hook selbst; die CLI
kennt keine Install-Phase und hat nie eine ausgeführt.

### Dateien ausnehmen

Manche Dateien gehören nur in manche Projekte: `.pnpmfile.mjs` liest nur pnpm, in einem
npm-Projekt wäre es eine Datei, die so aussieht, als täte sie etwas. `exclude` beantwortet das —
gefragt wird einmal, vor dem ersten Schreiben:

```js
export function exclude(ctx) {
    // ctx.files: alle Pfade, die template/ mitbringt
    return isPnpm(ctx.cwd) ? [] : ['.pnpmfile.mjs'];
}
```

Zurückgegeben werden die Pfade, die **nicht** installiert werden sollen. Damit kann ein Hook ein
Template nur verkleinern, nie erweitern; ein Pfad, den `template/` nicht enthält, ist ein Fehler
und bricht den Lauf ab (Hooks-Datei und `template/` kommen aus demselben Commit — ein unbekannter
Pfad ist dort ein Tippfehler und keine Eigenschaft des Zielprojekts).

Ein Array ist dabei nur die bequemste Form, verlangt wird ein Iterable. `function*` und
`async function*` sind also genauso gültig — bei mehreren Bedingungen oft die lesbarere Variante,
weil jede für sich steht:

```js
export function* exclude(ctx) {
    if (!isPnpm(ctx.cwd)) yield '.pnpmfile.mjs';
    if (!hasTypeScript(ctx.cwd)) yield 'tsconfig.base.json';
}
```

Ändert sich die Antwort später — das Projekt wechselt von pnpm zu npm —, gilt für die bereits
installierte Datei dieselbe Regel wie für eine, die upstream gelöscht wurde: unverändert
gegenüber der Merge-Basis wird sie entfernt (`removed`), lokal geändert bleibt sie liegen
(`kept`) und gehört ab dann dem Projekt.

Dazu kommt eine **dritte Regel**, zusätzlich zu den beiden oben: `exclude` muss **frei von
Seiteneffekten** sein und für ein gegebenes Repository immer dasselbe antworten. Er schreibt
nichts — auch nicht ohne `ctx.check`.

Was er ausgenommen hat, steht in `/.scaffold.json` unter `excluded`. Das ist der Grund, warum es
dort steht: **mit `--no-hooks` fragt niemand**, und ohne den Eintrag würde die CI jede
ausgenommene Datei bei jedem Lauf als fehlend melden. Mit `--no-hooks` wird die zuletzt notierte
Antwort unverändert weiterverwendet — bei `init --no-hooks` gibt es noch keine, dort wird also
alles installiert.

### Sicherheitsmodell

**`scaffold.hooks.mjs` ist fremder Code, der in diesem Prozess läuft, auf dem Host, ohne
Sandbox, mit den Rechten der ausführenden Person.** `scaffold init org/repo` ist genauso
gefährlich wie `curl … | sh` von den Betreibern dieses Repos. Eine Sandbox ist nicht möglich,
ohne den Hooks ihren Zweck zu nehmen — sie sollen ins Projekt schreiben.

Daraus folgt:

- Nur Scaffolds aus Repos ausführen, denen man Commit-Rechte geben würde.
- Für alles Automatisierte auf Tag oder Commit pinnen. Der aufgelöste Commit steht in
  `/.scaffold.json` und ist damit im Review sichtbar.
- **In der CI `--no-hooks` setzen.** Hooks laufen auch unter `--check` (sie bekommen
  `ctx.check: true`), weil `--check` sonst nicht sehen könnte, was sie verwalten — ein
  `--check`-Job ohne `--no-hooks` führt also fremden Code auf dem Runner aus. Was `exclude`
  entschieden hat, bleibt trotzdem sichtbar: es steht in `/.scaffold.json` und wird von dort
  gelesen, statt neu gefragt zu werden.
- Nicht als root laufen lassen.

Der Clone selbst ist abgesichert: keine git-Hooks, kein Template-Verzeichnis, keine Submodule,
keine Symlinks, kein Terminal-Prompt, nur `https`/`ssh`/`file` als Transport, und Refs, die mit
`-` beginnen oder `ext::` enthalten, werden abgelehnt, bevor sie ein argv erreichen. `git` wird
nie über eine Shell gestartet.

## `/.scaffold.json`

```jsonc
{
    "scaffolds": {
        "devcontainer-scaffold": {
            "repo": "neoskop/devcontainer-scaffold",
            "ref": { "kind": "tag", "value": "v0.1.0" },   // gewünscht
            "commit": "888bfbf…",                           // installiert, und die Merge-Basis
            "excluded": [".pnpmfile.mjs"]                   // fehlt, wenn nichts ausgenommen ist
        }
    }
}
```

`ref` gegen `commit` ist die wichtige Trennung: `update --check` löst `ref` neu auf und
vergleicht mit `commit`, damit „es gibt einen neuen Tag, aber die Dateien liegen noch nicht
hier" überhaupt erkennbar ist.

**Keine Dateiliste.** Welche Pfade ein Scaffold besitzt, steht hier absichtlich nicht: das ist das
Template bei `commit`, minus `excluded`. Also genau die Merge-Basis, die `update` ohnehin holt und
ohne die es nichts schreibt. Eine zweite, mitcommittete und handeditierbare Kopie derselben Liste
könnte mit dem Baum, aus dem sie stammt, nur uneins werden.

Damit ist auch die Frage „war diese Datei überhaupt mal Teil des Templates?" beantwortet — sie
steht im Basis-Baum. Ob eine upstream verschwundene Datei dann *gelöscht* werden darf, entscheidet
dieselbe Basis: nur was noch identisch mit ihr ist, wird entfernt — alles andere hat jemand
angefasst und bleibt liegen, ab dann unbeansprucht.

`excluded` ist die einzige Angabe hier, die eine *zwischengespeicherte Antwort* ist statt einer
Entscheidung: was der `exclude`-Hook des Templates ausgenommen hat. Notiert wird es, weil
`--no-hooks` den Hook nicht fragt — siehe [Dateien ausnehmen](#dateien-ausnehmen) — und weil es
der Teil des Basis-Baums ist, der nie in diesem Projekt gelandet ist. Nimmt ein Template nichts
aus, fehlt der Schlüssel ganz.

Mehrere Scaffolds pro Projekt sind der Normalfall — `--name` vergibt den Schlüssel. Zwei
Scaffolds, die dieselbe Datei beanspruchen, werden abgelehnt, statt sich bei jedem Update
gegenseitig zu überschreiben. Was die *anderen* Scaffolds besitzen, wird auf demselben Weg
ermittelt: aus dem Template bei dem Commit, den ihr eigener Eintrag nennt. Ein Projekt mit einem
Scaffold holt dafür nichts, bei mehreren kostet es einen Checkout pro weiterem Scaffold; ist
dessen Remote nicht erreichbar, sagt der Report das und prüft die Überschneidung mit ihm nicht,
statt sie zu erraten. Eine ausgenommene Datei zählt nicht mit: was dieses Projekt ohnehin nie
bekommt, kann auch nicht umstritten sein.

## Woher die Merge-Basis kommt

Das Template bei dem Commit, der in `commit` steht. Nicht im Projekt abgelegt, sondern nach
`~/.cache/neoskop-scaffold/<repo>/<commit>/` entpackt — eine mitcommittete Kopie wäre Eingabe
für einen Merge-Algorithmus mitten im Arbeitsverzeichnis, die ein Formatter oder ein
Suchen-und-Ersetzen still umschreibt.

Weil ein Commit unveränderlich ist, ist die Basis nach dem ersten Holen dauerhaft offline
verfügbar. Hat sich nichts bewegt, ist der frisch geholte Baum selbst die Basis und es gibt
keinen zweiten Round-Trip.

Lässt sich die Basis nicht beschaffen, bricht `update` mit Exit-Code 2 ab und schreibt nichts.
Nur die sicheren Dateien zu schreiben ginge nicht: dafür müsste der neue Commit eingetragen
werden, und der *nächste* Merge liefe dann gegen einen Stand, der nie auf der Platte lag.

| | |
| --- | --- |
| `update --base <dir>` | ein lokaler Checkout des Template-Repos als Basis |
| `NEOSKOP_SCAFFOLD_NO_FETCH=1` | nichts holen; der Cache wird weiter benutzt |
| `NEOSKOP_SCAFFOLD_CACHE_DIR` | wohin gecacht wird |
| `NEOSKOP_SCAFFOLD_NO_HOOKS=1` | wie `--no-hooks` |

## In CI

```yaml
- run: pnpm dlx @neoskop/scaffold@latest update --check --no-hooks
```

Exit-Code 1, wenn ein Scaffold veraltet ist oder unaufgelöste Konfliktmarker im Repo liegen.
Der Check holt das Template-Repo, braucht also Egress zum Host — **über HTTPS**: eine
SSH-Spec funktioniert aus einem Container mit CONNECT-Proxy heraus nicht.

Ist das Remote nicht erreichbar, meldet `--check` das als *unbekannt* und nicht als „veraltet".

## Entwicklung

| Datei | Zuständig für |
| --- | --- |
| [bin/bin.mjs](bin/bin.mjs) | Entry-Point (Shebang), sonst nichts |
| [src/cli.ts](src/cli.ts) | Argumente, Dispatch, Exit-Codes |
| [src/spec.ts](src/spec.ts) | die Repo-Spec — und damit die Eingabevalidierung für alles, was ein argv erreicht |
| [src/git.ts](src/git.ts) | Refs auflösen, Commits holen, Cache |
| [src/template.ts](src/template.ts) | `template/` durchlaufen, Text von Binär trennen |
| [src/state.ts](src/state.ts) | `/.scaffold.json` |
| [src/sync.ts](src/sync.ts) | die Entscheidung pro Datei |
| [src/merge.ts](src/merge.ts) | 3-Way-Merge über `git merge-file` |
| [src/hooks.ts](src/hooks.ts) | `scaffold.hooks.mjs` laden und aufrufen |
| [src/env.ts](src/env.ts) | was die Commands außerhalb des Zielprojekts anfassen — injizierbar, damit Tests hermetisch bleiben |

```bash
pnpm test        # vitest run
pnpm typecheck   # tsc --noEmit
pnpm build       # -> dist/
```

Die Tests legen echte Git-Repos in Temp-Verzeichnissen an und klonen sie über `file://`, treiben
also denselben Code wie ein echter Lauf. `GIT_ALLOW_PROTOCOL=file` in
[test/setup.ts](test/setup.ts) sorgt dafür, dass ein versehentlicher Netzzugriff sofort
scheitert, statt hinauszugehen.

## Release

```bash
pnpm release:patch      # 0.1.0 -> 0.1.1
pnpm release:minor      # 0.1.0 -> 0.2.0
pnpm release:major      # 0.1.0 -> 1.0.0
pnpm release:next       # 0.1.0 -> 0.1.1-next.0, danach -> 0.1.1-next.1
```

Dahinter steht `pnpm version <type>`, mehr nicht. Ein Lauf hebt `version` in
[package.json](package.json) an, committet genau diese eine Datei mit der neuen Version als
Commit-Message und setzt den annotierten Tag `v<version>`. Davor laufen über `preversion` die
Tests — und damit der Build; danach schiebt `postversion` Branch und Tag zusammen mit
`git push --follow-tags origin HEAD` nach `origin`. Für die Fälle, die `next` nicht ausdrückt,
gibt es zusätzlich `release:premajor`, `release:preminor` und `release:prepatch`; eine exakte
Version oder ein anderer `--preid` geht direkt über `pnpm version`.

Der Tag ist es, der publiziert: [.github/workflows/publish.yml](.github/workflows/publish.yml)
läuft auf `v*`, **prüft Tag gegen `package.json#version`**, verlangt, dass der Tag ein Vorfahre
von `origin/main` ist, und veröffentlicht dann nach npm — Prereleases unter dem dist-tag `next`,
alles andere unter `latest`. `latest` wird also nie von einem Prerelease bewegt, was für
`pnpm dlx @neoskop/scaffold@latest` in fremden CIs zählt. Der Workflow bumpt und committet
nichts: er findet die Version vor, die im Tag steht.

Ein `--dry-run` gibt es hier nicht. `pnpm version <type> --dry-run` nimmt die Option zwar an,
bumpt, committet und taggt aber trotzdem — sie greift nur im rekursiven Modus. Wer den Plan
sehen will, rechnet ihn aus `version` in [package.json](package.json) selbst aus.

Im Devcontainer gibt es weder DNS noch SSH-Agent. Bump, Commit und Tag entstehen dort trotzdem,
nur `postversion` scheitert am Push; nachgeholt wird er vom Host mit
`git push --follow-tags origin HEAD`.

Kein `pnpm change`: pnpm 11.20 kennt zwar `pnpm change` — Change-Intents im Changesets-Format
unter `.changeset/` — und `pnpm version -r`, das sie einlöst. Für dieses Repo trägt das nicht.
Das Paket *ist* die Workspace-Root, und `pnpm version -r` bumpt es nicht (`0.1.0 → 0.1.0`),
löst die Intents aber trotzdem im Ledger ein; in einem echten Workspace bricht derselbe Aufruf
mit `Cannot read properties of undefined` ab. Dazu kommt, dass `-r` Commit und Tag
grundsätzlich auslässt — der Tag, von dem `publish.yml` lebt, müsste also ohnehin von Hand
entstehen. Ein einzelnes Paket braucht kein Changeset-Ledger; die Commit-Historie ist das
Changelog.

Die npm-Seite ist einmalig einzurichten: Trusted Publishing (OIDC) lässt sich erst für ein
existierendes Paket konfigurieren, `0.1.0` muss also einmal von Hand veröffentlicht werden.
Danach unter Package Settings `neoskop/scaffold` + `publish.yml` als Trusted Publisher
eintragen; ein `NPM_TOKEN` braucht der Workflow dann nicht.
