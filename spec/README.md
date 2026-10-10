# Spec appendices

The build spec arrived truncated: everything after section 15.6 item 6 was lost, including
**Appendix A** (exact algorithms: go-around, holds, callsign normalisation) and **Appendix D**
(all reference data: airports, fixes, runways, map outlines, sectors, SIDs, aircraft, callsigns,
the IRFD / IPPH ground maps and the 18 legacy scenarios).

Save the full text of those appendices in this folder. Then:

1. Transcribe each Appendix D block into the file named in its heading under `/data`
   (formats: `data/README.md`). The ground maps go to `data/ground/irfd.json` and
   `data/ground/ipph.json`, the scenarios to `data/scenarios/*.sbx`.
2. Run `pnpm data` to rebuild the generated JSON, then `pnpm test`.

If an appendix uses a different file format from the one in `data/README.md`, adapt
`scripts/build-data.ts` (each file has its own small parser there).
