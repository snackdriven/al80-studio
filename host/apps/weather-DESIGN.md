# Weather slide — design notes

A second ambient info-panel for the AL80's 96x160 LCD, built to the same shape as now-playing:
a pure `render(state)` app, a data-source lib with a mock, a poll-loop runner, and pure tests.
This doc captures the decisions and the options I weighed before scaffolding.

## Data source: Open-Meteo (no API key)

`https://api.open-meteo.com/v1/forecast`

The whole reason to pick Open-Meteo over OpenWeatherMap / WeatherAPI / Tomorrow.io is that it
needs **no API key and no signup** — a zero-credential run is possible the same way the Spotify
mock gives us a zero-credential now-playing run. That matches the project's "runs with nothing
configured" habit (`getNowPlayingMock`). Open-Meteo's free tier is generous (10k calls/day,
non-commercial) and we poll once every 10 min, so ~144 calls/day. Nowhere near the ceiling.

### Query params

```
?latitude=42.33
&longitude=-83.05
&current=temperature_2m,weather_code,is_day
&daily=temperature_2m_max,temperature_2m_min
&temperature_unit=fahrenheit        (or celsius)
&timezone=auto                      (so "today" in daily[] is the location's local day)
&forecast_days=1                    (we only draw today's hi/lo)
```

- `current.temperature_2m` — the big number.
- `current.weather_code` — WMO code, drives condition text + icon.
- `current.is_day` — 1/0, flips the clear icon between sun and moon (and could theme day/night).
- `daily.temperature_2m_max[0]` / `daily.temperature_2m_min[0]` — today's hi/lo row.

Open-Meteo returns exactly one unit per request. We fetch in the configured unit and convert to
the other on our side (F = C*9/5+32), so the normalized state carries both `tempF`/`tempC` (and
`hiF/loF/hiC/loC`) regardless of what was requested. `render()` then shows whichever `state.units`
asks for. Keeps the app pure and unit-agnostic; the lib owns the conversion.

### Config (env, no geocoding for the scaffold)

Mirrors `spotify.js`'s `getAccessToken(env)` convenience with `getWeatherFromEnv(env=process.env)`:

| env | meaning | default |
|-----|---------|---------|
| `WEATHER_LAT`   | latitude  | 42.33 (Detroit) |
| `WEATHER_LON`   | longitude | -83.05 |
| `WEATHER_UNITS` | `F` or `C` | `F` |
| `WEATHER_LABEL` | location text drawn on the card | `LOCAL` |

No geocoding: you drop in lat/lon from env. **Future add:** a `geocode(name)` helper against
Open-Meteo's free geocoding endpoint (`geocoding-api.open-meteo.com/v1/search?name=Detroit`) so a
`WEATHER_PLACE=Detroit` resolves to lat/lon/label automatically. Out of scope here — lat/lon only.

## WMO weather_code -> condition text + icon

`weatherCodeInfo(code, isDay)` -> `{ condition, icon }`. Icon is a string id the app draws.
Icon ids: `sun` `moon` `cloud` `rain` `snow` `bolt` `fog`.

| WMO code(s) | condition (UPPERCASE — font is caps-only) | icon |
|-------------|-------------------------------------------|------|
| 0           | CLEAR            | is_day ? `sun` : `moon` |
| 1           | MOSTLY CLEAR     | is_day ? `sun` : `moon` |
| 2           | PARTLY CLOUDY    | `cloud` |
| 3           | OVERCAST         | `cloud` |
| 45, 48      | FOG              | `fog`  |
| 51, 53, 55  | DRIZZLE          | `rain` |
| 56, 57      | ICY DRIZZLE      | `rain` |
| 61, 63, 65  | RAIN             | `rain` |
| 66, 67      | ICY RAIN         | `rain` |
| 71, 73, 75  | SNOW             | `snow` |
| 77          | SNOW GRAINS      | `snow` |
| 80, 81, 82  | SHOWERS          | `rain` |
| 85, 86      | SNOW SHOWERS     | `snow` |
| 95          | THUNDERSTORM     | `bolt` |
| 96, 99      | THUNDERSTORM     | `bolt` |
| (unknown)   | ---              | `cloud` |

`is_day` only matters for code 0/1 (clear): sun by day, moon by night. Everything else reads the
same day or night, so it keeps the map small.

### Icons — 2-color pixel art, ~40px, drawn with fillRect/setPx

Kept legible at a glance, no anti-aliasing (the panel is tiny and the font is a hard 5x7 bitmap, so
crisp blocky icons match). Each icon = an accent shape + one secondary tone. Primitives I add:
`filledCircle` (scanline fill) and `ring` for the sun/moon disc; clouds are 2-3 overlapping discs
capped by a flat base bar; rain/snow are a cloud with short strokes / dots beneath; bolt is a
hand-plotted zigzag polygon over a cloud; fog is 4 stacked wavy bars.

Accent color per condition seeds both the icon and the bottom accent bar (same idea as
now-playing theming its progress bar off the cover):

| icon  | accent (roughly) |
|-------|------------------|
| sun   | warm gold `[245,190,70]` |
| moon  | pale indigo `[150,160,220]` |
| cloud | slate `[150,165,185]` |
| rain  | blue `[90,150,225]` |
| snow  | ice `[180,210,235]` |
| bolt  | amber-yellow `[240,205,80]` |
| fog   | muted gray `[160,168,178]` |

## Layout (96 wide x 160 tall)

Degree symbol: the 5x7 font has **no `°` glyph** (it only carries 0-9, `:`, space, `-`, `/`, `.`,
A-Z). So I draw a tiny hollow ring in code (`drawDegree`) as a superscript next to the number
rather than rendering a character. `/` exists but I use a spaced HI/LO row instead of "78/61".

```
+----------------------------------------+  y=0
|               DETROIT                   |  location label, scale 1, centered, y=5
|                                         |
|              .-''''-.                   |
|             (  ICON  )                  |  ~44x44 condition icon, centered, y≈18..58
|              '-....-'                   |
|                                         |
|              7 2°                        |  big temp, scale 4 (20x28/glyph) centered, y≈70
|                                         |         degree ring drawn top-right of digits
|            PARTLY CLOUDY                 |  condition text, centered, wraps to 2 lines, y≈104
|                                         |
|          HI 78°     LO 61°               |  hi/lo row, scale 1, y≈128
|                                         |
| [==============accent bar=============]  |  y=152, h=4, condition accent
+----------------------------------------+  y=160
```

Big temp at scale 4: a 2-digit temp is `2*20 + 4gap = 44px` + the degree ring, comfortably inside
96 and centered. Negative ("-5") and 3-digit-ish edge cases still fit. Condition text is centered
and wraps to at most 2 lines with the same char-ellipsis trick now-playing uses (font has only `.`,
so a single dot stands in for `…`).

## Refresh cadence: ~10 min

`POLL_MS = 10 * 60 * 1000`. Weather is slow: Open-Meteo's `current` block updates about every
15 min, and the temperature a human reads off a keyboard doesn't need second-resolution. Polling
every 10 min keeps the panel fresh, stays polite to a free no-key API, and there's no animated
element to refresh between polls (unlike the Spotify progress bar, which re-pushed every 15s to
advance). We push immediately on first run, then only re-push when the rendered state actually
changes (temp / code / hi / lo), so the picture ring isn't churned needlessly.

## Coexistence: one screen, one owner

The LCD is a single surface with a single owner — weather and now-playing **cannot both drive it at
once**. This is the same "one screen, one owner" constraint now-playing already lives under (only
one process may hold the 0xFF60/0x61 HID interface; `device.js` throws "device busy" otherwise).
Deciding *when* weather yields to now-playing (e.g. weather as the resting slide, now-playing taking
over while music plays, or a timed rotation) is a scheduler concern and **future work, out of scope
for this scaffold**. For now `weather-run.mjs` is a standalone runner just like `nowplaying-run.mjs`:
you run one or the other.
```
