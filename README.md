# getmotion

Private recast engine: upload a clip, click a person, SAM 2 tracks a mask through every frame, swap them with a photo via fal.ai.

```bash
cp .env.example .env.local   # add FAL_KEY
npm run dev
```

Vercel: set `FAL_KEY`, `SUME_API_KEY` and `APP_PASSWORD` (basic auth on the whole site).

Models live in `src/lib/models.ts` — add one entry per fal endpoint.
