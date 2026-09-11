# Bali Air Dispatch — Data Sources and Methodology

### A technical reference: what we collect, how often, what we correct, and what we do not claim

*Prepared 3 September 2026. Describes the system as deployed on that date. Every figure in this document is reproducible from the public API described in §10.*

---

## 1. Purpose of this document

Bali Air Dispatch is a non-commercial public-interest archive of particulate-matter readings across Bali. It operates no sensors of its own. It aggregates eight independent monitoring networks into a single continuously-archived record, applies one published correction, and publishes the result openly.

This document is the technical reference for that process. It is written to be checked rather than trusted: every rule below is stated precisely enough to be independently verified against the open API, and the sections on limitations (§9) are as detailed as the sections on method.

Three things are worth stating at the outset, because they shape everything that follows:

- **We do not own any measurement in this archive.** Every reading originates from a third-party network and remains subject to that network's own terms.
- **Low-cost sensors are not reference-grade instruments.** Nothing here is offered as a substitute for a calibrated reference monitor.
- **One methodological choice — humidity correction — changes the headline compliance figure by roughly 29 percentage points.** That finding is set out in full in §6, because any discussion of what the data shows has to begin with it.

---

## 2. Summary

| | |
|---|---|
| **Networks ingested** | 8 (AirGradient, IQAir, PurpleAir, AQICN/WAQI, Nafas, Smart Citizen, OpenAQ, Airly) |
| **Stations in catalogue** | 76 |
| **Stations reporting live** | 39 (at time of writing) |
| **Government reference stations available** | 1 (Denpasar Lumintang, KLHK, via AQICN) |
| **Archive depth** | Earliest record 27 September 2023; 4,197 station-days total; longest single station 572 days |
| **Collection interval** | 15 minutes, continuous |
| **Correction applied** | US-EPA 2021 humidity correction, on 2 of 8 networks, since 21 July 2026 |
| **Directly-contributed (pushed) stations** | 1 — Amed, East Bali; published raw, uncorrected — see §5.6 |
| **Published intervals** | Raw (15-min), hourly, daily |
| **Licence** | Open, attribution requested; full archive downloadable as JSON or CSV |

---

## 3. The networks we ingest

Each network is polled independently. A network that fails or times out is simply absent from that cycle; it never blocks or degrades the others. The upstream timeout is 8 seconds per request.

| Network | What it is | Instrument | Access | Catalogued stations |
|---|---|---|---|---|
| **AirGradient** | Open community network; the densest source in Bali | AirGradient O-1PST (Plantower PM module) | Public API, no key | 19 |
| **OpenAQ** | Aggregator. **In Bali, every OpenAQ station is an AirGradient unit relayed onward** — see §6 | (relayed) | Public API, key | 22 |
| **IQAir** | Commercial network; mixture of private hosts and contributors | Various | Public station pages, one device each — town-level values are not used (§8.5) | 10 |
| **PurpleAir** | Open community network | PurpleAir (Plantower PM module) | Public API, key | 2 |
| **Smart Citizen** | Open citizen-science platform (Fab Lab Barcelona) | SmartCitizen Kit 2.3 | Public API | 11 |
| **Nafas** | Indonesian commercial network | Nafas Foundation sensor | Public JSON feed | 7 |
| **AQICN / WAQI** | Aggregator; carries the **KLHK government reference station** | Reference-grade (government); GAIA (community) | Public API, token. The feed carries AQI sub-indices, converted to µg/m³ (§10.2) | 2 |
| **Airly** | Commercial network | Airly sensor | Public API, key | 2 |

**Geographic filter.** All networks are filtered to the same Bali bounding box: latitude −9.2 to −8.0, longitude 114.4 to 115.8. The filter is applied identically in the live aggregator and the archive worker.

**On the single government station.** Of 76 catalogued stations, exactly one is a government reference instrument: Denpasar Lumintang (KLHK), reached through AQICN. It is not enumerated by AQICN's map endpoint and has to be probed directly by station ID. This is the principal monitoring gap in the record and is the main reason the archive exists in its present form.

### 3.1 A ninth, categorically different source: direct contribution

The eight networks above are all **polled** — we call a public API on our own schedule. One station reaches us the opposite way: a resident-operated sensor **pushes** its own readings directly to this project's ingest endpoint. It is not a third-party network we ingest from, which is why it is not counted among the eight above; it is a second point of entry into the same archive, one this project itself operates.

As of this writing there is one such station: `cs-amed-01` ("Amed (north)"), a Winsen ZH03B unit on Bali's remote east coast, reporting since 27 August 2026. It fills a real gap — the nearest other monitor of any kind, a PurpleAir unit, is **33.8 km** away, and no multi-year record exists anywhere in East Bali. Its readings are published **raw, not humidity-corrected**, for a specific and important reason set out in full in §5.6, which any use of this station's figures should be read alongside.

For privacy, the contributor is not named in this document; the project's practice throughout is that operators and contributors are not identified.

### 3.2 A categorically different observation: satellite fire detections

Everything above measures **particulate matter** — the smoke. NASA FIRMS measures something else entirely: the **thermal signature of an active fire**, observed from orbit. It is included here because it speaks directly to the limitation in §9.2 — that a PM2.5 sensor cannot attribute a reading to a source — without resolving it.

| | |
|---|---|
| **Source** | NASA FIRMS (Fire Information for Resource Management System), LANCE/ESDIS |
| **Instrument** | VIIRS aboard Suomi-NPP, NOAA-20 and NOAA-21 |
| **Resolution** | **375 m** |
| **Access** | Area API, free `MAP_KEY`, CSV |
| **Latency** | ~60 minutes (near-real-time product) |
| **Served at** | `/api/hotspots`, not `/api/live` — it is not a station and carries no PM2.5 value |
| **Cadence** | Edge-cached 15 minutes; a 2-day trailing window |

MODIS is deliberately **not** ingested. At 1 km it is coarser than the fires this project cares about, and it would add duplicate detections of the large fires without revealing any of the small ones.

**Multi-satellite de-duplication.** The three VIIRS platforms frequently observe the same fire. Detections within ~500 m and 30 minutes of one another are collapsed to one, keeping the observation with the highest fire radiative power. 500 m is a little over one VIIRS pixel — wide enough to merge genuine double-observations, narrow enough not to merge two neighbouring fires.

**What this source can and cannot support.** It is good evidence that a fire *was* present at a place and time. It is very weak evidence that one was *not*, for four separate reasons:

1. **Detection floor.** At 375 m, VIIRS reliably detects landfill and agricultural fires — a TPA Suwung fire shows clearly. It does **not** detect household backyard burning, which is small, brief and often under tree cover. **A quiet hotspot map on a high-PM2.5 day means the burns were small, not that nobody was burning.** Any interface presenting this layer has to say so, or it will be read backwards — as exoneration rather than as a resolution limit.
2. **Overpass gaps.** These are polar orbiters, not geostationary satellites. A fire that begins and ends between overpasses is never observed at all.
3. **Cloud.** Thermal detection is degraded or blocked by cloud cover, which in Bali is neither rare nor evenly distributed through the year.
4. **Not specific to waste.** A detection is a hot object. Cooking fires, cremation ceremonies, land clearing and industrial heat all qualify.

The endpoint distinguishes an **empty sky** from an **unavailable source**: if every satellite request fails, or no key is configured, it returns `available: false` with an empty array rather than an empty result that would read as zero fires. This is the honest-gap rule of §8 applied to a non-particulate source.

---

## 4. Collection schedule

Three scheduled processes run continuously on Cloudflare's edge network.

| Process | Schedule | Function |
|---|---|---|
| **Universal archive** | `*/15 * * * *` — every 15 minutes, on the hour and at :15, :30, :45 | Polls all live networks, writes one snapshot row per reporting station, upserts the station catalogue, rolls up hourly and daily aggregates |
| **IQAir capture** | `7,22,37,52 * * * *` — every 15 minutes, offset by 7 minutes | IQAir publishes only via station pages, so these are captured separately. One rotating group of ≤3 stations per tick (4 groups, full cycle each hour) to stay inside execution limits |
| **Archive watchdog** | Runs within the IQAir tick | If the universal archive has not written for **90 minutes**, the watchdog triggers a recovery run. Added after a CPU-limit failure caused a 60-minute hole in the record |

**Deliberate offset.** The IQAir schedule is offset from the universal archive so the two never contend for the same execution window.

**Retry behaviour.** The archive's fetch of the live aggregate retries three times with linear back-off. A single transient failure previously dropped an entire 15-minute tick with nothing to notice it.

**Idempotency.** Every write is keyed. Re-running any tick is a no-op — reruns cannot double-count or corrupt the record.

---

## 5. Data corrections

### 5.1 What is corrected, and what is not

We apply exactly one correction: the **US-EPA 2021 humidity correction for Plantower-based optical sensors**. It is applied to **two networks only** — AirGradient and PurpleAir — because those are the two whose public feeds carry an uncorrected Plantower reading.

**All six other networks are published exactly as supplied.** We do not adjust, scale, calibrate or reconcile them. The one change of *units* is AQICN, whose feed carries an index rather than a concentration (§10.2); converting it is arithmetic, not a correction.

Correction has been applied since **21 July 2026**. Rows archived before that date are uncorrected, and the API reports this per station in the field `pm25_correction_applied_since`.

### 5.2 Why the correction is necessary

A Plantower module sizes particles optically. In humid air, water-swollen particles scatter light as though they carried more mass than they do, so the sensor over-reads. Bali's 55–70% relative humidity inflates uncorrected readings substantially.

AirGradient applies this same formula to produce the corrected value shown on its own dashboard, but that field is exposed only on the device's local API and its token-gated cloud API — never on the anonymous public feed we read. The algorithm is published and we already ingest both required inputs, so we compute it ourselves rather than publish values we know run high.

### 5.3 The formula

Let `a` = raw PM2.5 (µg/m³) and `h` = relative humidity (%):

```
a < 30          →  0.524·a − 0.0862·h + 5.75

30 ≤ a < 50     →  f = a/20 − 1.5
                   (0.786·f + 0.524·(1−f))·a − 0.0862·h + 5.75

50 ≤ a < 210    →  0.786·a − 0.0862·h + 5.75

210 ≤ a < 260   →  f = a/50 − 4.2
                   (0.69·f + 0.786·(1−f))·a − 0.0862·h·(1−f)
                   + 2.966·f + 5.75·(1−f) + 0.000884·a²·f

a ≥ 260         →  2.966 + 0.69·a + 0.000884·a²
```

Negative results are clamped to zero, per the same EPA guidance.

**Both inputs are mandatory.** If either the raw reading or the humidity reading is missing, no correction is applied and the raw value is published unchanged, flagged as uncorrected. This is enforced by explicit type checking: a sensor with a failed humidity channel must not be silently corrected as though humidity were 0%, which is the maximum-inflation case.

**PurpleAir input selection.** The correction is fed PurpleAir's `cf_1` field, not `atm`. The EPA regression was fitted on CF=1 data; the ATM field applies its own high-range scaling, and feeding it under-corrects above roughly 25 µg/m³ — precisely the burn events this archive exists to document.

### 5.4 The correction is fully reversible

Every corrected row stores the exact uncorrected figure in `pm25_raw`, alongside the humidity used. The invariant `epaCorrect(pm25_raw, humidity) = pm25` holds for every archived row, so the correction can be independently recomputed, audited, or removed entirely. **Nothing the sensor actually reported is discarded.**

### 5.5 Measured magnitude

Across 800 consecutive readings from one AirGradient station (`ag-195872`):

| | Raw | Corrected |
|---|---|---|
| Mean | 15.6 µg/m³ | 9.9 µg/m³ |
| Median | 11.6 µg/m³ | 7.0 µg/m³ |
| Maximum | 75.5 µg/m³ | 60.4 µg/m³ |

The raw figure runs higher by a **mean of 5.8 µg/m³**, a **median ratio of 1.63×**. In 5.1% of readings — low concentrations in dry conditions — the correction *raises* the value rather than lowering it, which is the expected behaviour of the EPA regression and not an error.

### 5.6 The one exception: the Amed contributed station

Every correction rule above governs sources we **poll** on a fixed schedule. One station reaches us differently — see §3.1 — and its correction status needs to be stated on its own.

**What is published.** `cs-amed-01` ("Amed (north)") reports its PM2.5 reading exactly as the device measures it, with no adjustment. Verified against 500 consecutive archived readings: **every single one** carries `pm25_raw = null` and `pm25_corrected = false`. This is not a default that happens to apply — it is enforced explicitly by the ingest endpoint at the point of storage.

**Why raw, not corrected — precisely.** The station's controller does report a humidity reading; every one of the 500 sampled rows carries one. So the missing ingredient is not a humidity *channel*, and it is not that the correction formula in §5.3 is unsuited to this hardware — it is the same EPA formula applied to AirGradient and PurpleAir. What is missing is **confirmation that the humidity sensor is measuring the same air as the particulate sensor** — genuinely co-located, not a reading borrowed from elsewhere on the property or from a different device. Applying the formula without that confirmation would not fail loudly; it would silently produce a plausible-looking but potentially wrong number, which this project judges worse than an honest, clearly-labelled raw one. The ingest system encodes this as an explicit per-station flag, defaulted to *off*, that only this project can set once co-location with this specific contributor is confirmed — not an assumption baked into the correction logic itself.

**What the raw values look like.** Over its first 500 readings (27 August – 3 September 2026):

| Statistic | Value (raw, uncorrected) |
|---|---|
| Mean | 15.1 µg/m³ |
| Median | 13.5 µg/m³ |
| Maximum | 32.0 µg/m³ |

These figures should be read against the **Raw** column in §5.5, not the Corrected one — they are not directly comparable to a corrected reading from any other station on this network without first accounting for the same humidity over-read described in §5.2.

**Statistical treatment.** A contributed reading is unverified by construction: this project did not site the device and cannot inspect it. Consistent with every other unverified or non-ambient reading on this network (§8.3), `cs-amed-01` is shown on the public map and published through the API from its first reading onward, but it is **excluded from every island-wide statistic** — median, worst-current-reading, WHO exceedance share — until co-location is confirmed. This is the same treatment given to stations flagged `suspected_indoor`: published in full, held out of ambient claims.

---

## 6. The AirGradient / OpenAQ duplication, and why it matters

This section is the most consequential in the document, because it determines what number a given station appears to report.

### 6.1 The situation

**Every OpenAQ station in Bali is an AirGradient unit relayed through OpenAQ.** The same physical device therefore reaches us twice: once directly from AirGradient, once as an OpenAQ record. The relay reports the device's coordinates unchanged — all identified pairs match at exactly 0.000000 m separation, not merely "nearby."

The two copies are not equivalent:

- The **direct** feed is timestamped to the minute and carries the humidity inputs, so **we correct it**.
- The **relayed** copy arrives without those inputs and is published **exactly as OpenAQ supplies it — uncorrected**.

### 6.2 Measured difference, same physical device

Station `ag-195872` and its relay `oq-6403967` are one device. Over **295 matched hours (20 August – 2 September 2026)**:

| | AirGradient (direct, corrected) | OpenAQ (relay, uncorrected) |
|---|---|---|
| Mean PM2.5 | 18.7 µg/m³ | 27.4 µg/m³ |
| Median PM2.5 | 13.9 µg/m³ | 23.9 µg/m³ |
| Maximum | 96.7 µg/m³ | 127.8 µg/m³ |
| **Hours above WHO 24-hour guideline (15 µg/m³)** | **125 (42%)** | **209 (71%)** |

The relay reads higher by a **mean of 8.7 µg/m³**, a **median ratio of 1.62×**, and reads higher in **82% of matched hours**.

> **The policy-relevant point.** These two rows describe *the same air, measured by the same instrument, at the same moments.* The exceedance rate differs by **29 percentage points** depending solely on which copy is read and whether the humidity correction is applied. Any comparison between datasets — ours, a ministry dataset, or a third party's — must first establish which of these two conventions is in use. Otherwise the comparison measures methodology, not air.

### 6.3 Temporal resolution also differs

Both copies are polled every 15 minutes. They do not carry the same amount of information:

| | Distinct values in 800 polls | Median interval between value changes |
|---|---|---|
| AirGradient direct | 785 | **15 minutes** |
| OpenAQ relay | 186 | **45 minutes** |

The direct feed genuinely updates each poll. The relay republishes roughly every 45 minutes, so three consecutive polls typically repeat one value. For episodic pollution — which is what open burning produces — the relay materially understates short peaks.

### 6.4 How we resolve it

On the public map, a confirmed pair is collapsed to **one pin: the direct feed, always.**

- Suppression is **unconditional** once a pair is established.
- There is **no numeric failover** to the relay. If the direct feed goes quiet, the pin is shown as stale and excluded from published figures — it does not silently switch to the higher uncorrected number. Swapping between the two made a single pin jump 20–45% for the same air.
- Pairing is confirmed against our own archive, not a single poll, so a pair survives a temporarily missing reading. A twin that has produced no archived reading for **36 hours** is treated as departed and the relay stands alone again.
- If the AirGradient unit leaves the network permanently, no pair forms and the OpenAQ record is published normally.

**Both series are archived in full and both remain published through the API, under their own station IDs.** The de-duplication above is a *display* decision on the public map only. No historical data is discarded, and a researcher can retrieve either or both.

---

## 7. Other de-duplication rules

| Rule | Radius | Behaviour |
|---|---|---|
| **AirGradient ↔ OpenAQ relay pairing** | 1 m | Exact-coordinate identity; direct feed always wins (§6) |
| **AirGradient vs. other networks** | 300 m | An AirGradient pin is dropped if a *different* network already holds that location, so established station identities and their longer histories win. OpenAQ is exempt from this rule, for the reason in §6 |
| **Airly vs. Nafas** | 300 m | Airly is dropped near a *live* Nafas station. If Nafas is not reporting, Airly is retained as failover |
| **Smart Citizen** | — | De-duplicated against existing stations on the same basis |
| **IQAir mirrors** | — | Where IQAir republishes a sensor already ingested directly (e.g. a PurpleAir unit), both copies are flagged together so a filtered analysis cannot lose one and keep the other |

The tightest rule is deliberately the 1 m relay rule. A wider radius is unsafe for identity matching: anyone can register a device on a public network and enter arbitrary coordinates, and a 300 m rule could allow an unrelated registration to suppress a genuine station. At 1 m, with the relay reporting the device's own coordinates unchanged, nothing unrelated can qualify.

---

## 8. What we exclude, and when

### 8.1 Staleness

A reading older than its network's threshold is marked stale, rendered muted on the map, and **excluded from all island-wide statistics**. It is never deleted.

| Network | Threshold | Reason |
|---|---|---|
| AirGradient | 6 hours | Normally reports every few minutes; a 6-hour gap is a dead sensor, not a slow one |
| PurpleAir | 6 hours | Reports every two minutes; the same reasoning. Added 11 September 2026 (see §8.2) |
| OpenAQ | 6 hours | Republishes hourly and its timestamps are honest, so an old timestamp means genuinely old data |
| All others | 24 hours | Hourly and daily-aggregate networks can legitimately lag |

Staleness is computed as the **greater** of two ages: the upstream timestamp, and the moment we recorded the reading. Where the two disagree, the older is believed.

### 8.2 Readings never archived

- **Frozen sensors.** If a device's own reported reading time is more than **48 hours** behind the present, the catalogue entry is updated but no snapshot is written. This prevents a stuck sensor from filling the archive with a repeated stale value stamped as though fresh.
- **Null readings coerced to zero.** A device whose PM module has failed while its network connection persists reports a null value. These are rejected explicitly. Numeric coercion would turn null into a finite `0.0` and archive a false "clean air" record — the most damaging possible failure direction.
- **Missing or unparseable timestamps.** A reading that cannot demonstrate its own freshness is rejected rather than treated as current.
- **PurpleAir sensors that have stopped, or whose channels disagree.** A PurpleAir sensor that PurpleAir itself has not heard from for more than 6 hours at the moment we poll is not published or archived at all, and neither is a reading on which the unit's two laser channels disagree — by more than 5 µg/m³ *and* by more than 70% of their mean, the form of test EPA applies to PurpleAir data, so that two good channels reading 5 and 9 in clean air are not mistaken for a fault. Added 11 September 2026 after a newly registered unit sat on the map at 739 µg/m³ for sixteen hours with a frozen timestamp and a raw value that never moved — one dead laser channel — while PurpleAir's own map had already stopped showing it. Its rows were removed from the archive (recorded in `archive_corrections`); if it reports properly again it will reappear on its own.

### 8.3 Quality flags

Two flags mark stations whose readings are real but should not enter ambient statistics. **Flagged stations are published in full — every reading is served exactly as recorded — and excluded from every island-wide figure on the site.**

- **`suspected_indoor`** (3 stations): measuring a room, not ambient air.
- **`suspected_malfunctioning`** (none at present): reporting values that cannot be reconciled with any neighbouring sensor. The only station ever flagged, an IQAir pin labelled "Kopernik (Mas, Ubud)", was withdrawn in September 2026. It was not a faulty sensor; it was not a sensor at all (§8.5).

The flag is a judgement about the device, never a modification of its data.

### 8.4 Offline retention

When a station stops reporting permanently, its pin remains as a grey marker carrying its last archived date. Months of history never silently vanish because a device died. These carry no current reading and are excluded from all live statistics.

### 8.5 One point, one device

Every station on the map, in the archive and in the API is **one physical device at a known location, reporting its own measurement.** A town or city value, a satellite- or model-derived estimate, an interpolated surface or an average across devices is not a station, whatever the provider calls it, and is not ingested. Where a provider offers both levels — IQAir's API has `nearest_city` and `city` endpoints as well as individual station pages — only the station level is read.

**The incident behind the rule.** Until September 2026 the map carried one value from IQAir's `nearest_city` endpoint, pinned in Mas and labelled "Kopernik (Mas, Ubud)". The name came from a May 2026 audit, which read a "Data attribution" credit on IQAir's Ubud page as evidence of a device at Kopernik. There was no such device:

- Kopernik told us they have no monitor sending data to IQAir.
- IQAir's Ubud page lists two stations, both AirGradient devices this archive already ingests directly: Bindu Ricefields and Villa Malaikat. The pin counted them a second time, under another name, at a location we assigned.
- It was not their average either. On 13 of the 18 days on which both devices reported, it ran more than 15% above the *higher* of their two raw readings. On 28 August it read 200.9 µg/m³ against 44.2 and 31.0. Whatever else goes into IQAir's town value is not disclosed.

On 27 August it was flagged `suspected_malfunctioning` (§8.3). That was the wrong diagnosis: a malfunctioning sensor is still a sensor. Until that flag it counted toward the island-wide figures.

**What was done.** The `nearest_city` request was removed. Every id in the `iq-` namespace, which only that endpoint ever produced, is excluded from every listing and returns `410 Gone` instead of data. That is eight ids: the "Kopernik" series, its earlier id `iq-Ubud`, and six other town values already hidden in May 2026 (five satellite-model estimates, and a Jimbaran value that duplicated a PurpleAir device we ingest directly). Their archived rows are withheld from publication but retained, so the withdrawal itself stays auditable: they were moved out of the live tables into three `retired_*` tables (`schema-v9-retired-aggregates.sql`) that no endpoint reads. IQAir's real stations are unaffected: each is read from its own station page and carries an `iqs-` id.

This is unrelated to the AirGradient units that OpenAQ lists under the name "Kopernik" (October 2025 – March 2026). Those were physical devices, and their record remains in the archive.

---

## 9. Limitations — what this archive cannot tell you

Stated plainly, because a reference document that omits them is not usable for policy.

1. **We cannot measure dioxins or furans.** PM2.5 and VOC sensors do not speciate. Where burning plastic is the concern, dioxins are among the most serious hazards, and **every network in this document — including ours — measures a proxy, not the most toxic component of the smoke.** Proper dioxin measurement requires laboratory sampling.

2. **We cannot attribute a reading to a source.** A PM2.5 sensor weighs smoke; it cannot chemically distinguish burning plastic from burning agricultural residue from vehicle exhaust. Consistent daily timing patterns across many stations are suggestive of a shared cause; they are not proof of one. Any confident claim about a *specific* facility — in either direction — is unproven by this data. The FIRMS hotspot layer (§3.2) is a partial and asymmetric help here: it can corroborate that a *large* fire was burning nearby, but its 375 m detection floor means it cannot see household burning at all, so it can never be used to argue that a source was absent.

3. **There is no calibration reference available in Bali.** We know of no facility where a citizen-operated monitor can be checked against a reference-grade instrument at both high and low concentrations. Until one exists, every low-cost sensor's error — including whether it is a constant offset or a scaling factor — is an estimate. **This is the single highest-leverage gap in the record, and it needs an institution with a reference instrument to close it.**

4. **Low-cost sensors drift in tropical humidity.** The correction in §5 addresses the dominant known bias. It does not address per-device manufacturing variation, which AirGradient handles with an unpublished batch-level factor we cannot reproduce.

5. **Coverage is uneven and volunteer-determined.** Sensors exist where residents installed them, which is not where pollution is worst. Sanur, Ubud and Gianyar are materially under-covered. Absence of data is not evidence of clean air.

6. **The network is not under our control.** Commercial networks have withdrawn from Bali mid-season before, taking their live feeds with them. Everything they published while present remains in this archive.

---

## 10. Aggregation, intervals, and access

### 10.1 Intervals

| Interval | Definition |
|---|---|
| **Raw** | 15-minute snapshots exactly as fetched. Not available for IQAir stations, which publish hourly |
| **Hourly** | Hourly means. Native for Nafas and IQAir; bucketed from raw snapshots for all other networks |
| **Daily** | Daily means, with minimum, maximum and sample count |

**Time basis.** All instants are UTC, ISO-8601. **Daily aggregates are WITA (UTC+8) calendar days**, not UTC days — the local day is the meaningful unit for a Bali reader, and each response states which basis applies.

**Sample counts.** Every aggregate row carries `samples`. Some older daily rows carry `samples = 1` — a single backfilled observation, with min = max = mean. A low sample count should be treated as a weak average.

### 10.2 AQI conversion

Where a network publishes only an AQI value, PM2.5 is derived using the US-EPA breakpoint table that network uses, and values obtained this way are marked as such: `pm25_estimated` on the live feed, `pm25_from_aqi` on every API row and station.

**AQICN / WAQI is such a network.** Its feed reports the US-EPA *AQI sub-index* for each pollutant, not a concentration ("all the values … are already converted from the raw concentration … to the individual pollutant AQI, according to the US EPA standard"). WAQI uses the 2012 EPA breakpoints (0–12.0 → 0–50, 12.1–35.4 → 51–100, 35.5–55.4 → 101–150, 55.5–150.4 → 151–200, 150.5–250.4 → 201–300, 250.5–350.4 → 301–400, 350.5–500.4 → 401–500), not the 2024 revision, and the inversion is linear within each band. Because the index is a whole number, the recovered concentration is exact to about ±0.25 µg/m³ below 55 µg/m³ and about ±1 µg/m³ above; the original index can always be recovered by applying the table forwards.

**The incident behind the marking.** From 26 April to 11 September 2026 the aggregator stored the sub-index as if it were µg/m³. The station affected was the one government reference instrument then reporting, Kabupaten Badung Sempidi: its archived daily mean was 37.6 µg/m³ with 99% of days over the WHO 24-hour guideline; in real units it is about 9, with none. Three independent checks established the error and the table: 12,039 of its 12,041 archived readings were whole numbers and none was ever above the station's overall AQI, which a concentration cannot do; inverted with the 2012 table its May 2026 mean is 8.1 µg/m³ against 8.0 at the three IQAir stations within 8 km (the 2024 table gives 6.1); and AQICN's export of the other government station, Denpasar Lumintang, shows 89.19 µg/m³ for its final hour on 9 August 2025, for which the API reported 168 — exactly the index of 89.19. The archived rows were converted in September 2026 by the same arithmetic, and the daily rows rebuilt from them; the conversion is recorded in the database (`archive_corrections`). AQICN's **downloadable station exports** are in µg/m³ and were never affected, so the historical Lumintang record (§3, and the Brief) stands as published. Dispatch VII quoted two Sempidi figures from the affected period and carries a correction.

### 10.3 Open access

The full archive is public, requires no account, and is available as JSON or CSV:

```
https://baliairdispatch.com/api/v1
```

- `/api/v1/stations` — full catalogue with coordinates, network, coverage dates, correction date and quality flags
- `/api/v1/latest` — most recent reading held for every station
- `/api/v1/measurements` — the time series; raw, hourly or daily; paged by cursor

Every response carries the licence terms and the semantic notes summarised in this document. **We would welcome the Ministry's technical staff testing any figure in this document directly against that endpoint.**

---

## 11. Standing offers

Three things this project can do that may be useful, offered without condition:

1. **Provide the complete archive** in any format required, including the uncorrected series, for independent analysis.
2. **Host a reference co-location.** If the Ministry can make a reference-grade instrument available even briefly, co-locating it with community sensors would establish the error characteristics of every low-cost device on this island. That result would be published openly and would benefit any party using low-cost sensor data in Indonesia, not only this project.
3. **Add monitoring where the Ministry considers it useful.** Coverage decisions are currently made by whoever volunteers to host a sensor. Direction toward locations of policy interest — waste-processing facilities, schools, under-covered regencies — would improve the record for everyone.

---

*Bali Air Dispatch is an independent, non-commercial, public-interest air-quality archive. It is not affiliated with any government body or commercial monitoring network. It sells nothing and carries no advertising. Readings originate from the independent networks named in §3 and remain subject to their own terms; this project aggregates and preserves them.*

*Contact: baliair@protonmail.com*
