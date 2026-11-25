"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui";
import { editPhotoAction, restorePhotoAction, type PhotoState } from "@/lib/items/photo-actions";
import { PhotoUpload } from "./PhotoUpload";

const IDLE: PhotoState = { status: "idle", message: "" };
const ZOOMS = [1, 2, 4] as const;
const SIDES = [
  ["top", "Top"],
  ["bottom", "Bottom"],
  ["left", "Left"],
  ["right", "Right"],
] as const;
type Side = (typeof SIDES)[number][0];

type Props = {
  itemId: number;
  imageId: number;
  src: string;
  alt: string;
  hasOriginal: boolean;
  canReplace: boolean;
};

export function PhotoTools({ itemId, imageId, src, alt, hasOriginal, canReplace }: Props) {
  const [zoom, setZoom] = useState<(typeof ZOOMS)[number]>(1);
  const [cut, setCut] = useState<Record<Side, number>>({ top: 0, bottom: 0, left: 0, right: 0 });
  const [asking, setAsking] = useState(false);
  const [turnState, turnAction, turning] = useActionState(editPhotoAction, IDLE);
  const [trimState, trimAction, trimming] = useActionState(
    async (prev: PhotoState, form: FormData) => {
      const next = await editPhotoAction(prev, form);
      if (next.status === "done") setCut({ top: 0, bottom: 0, left: 0, right: 0 });
      return next;
    },
    IDLE,
  );
  const [restoreState, restoreAction, restoring] = useActionState(
    async (prev: PhotoState, form: FormData) => {
      const next = await restorePhotoAction(prev, form);
      setAsking(false);
      return next;
    },
    IDLE,
  );
  const working = turning || trimming || restoring;
  const anyCut = cut.top + cut.bottom + cut.left + cut.right > 0;
  const shade = "pointer-events-none absolute bg-black/60";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="max-h-[65vh] overflow-auto rounded-xl bg-black" tabIndex={0} role="region" aria-label="The photo. Scroll to move around when zoomed in.">
          <div className="relative" style={{ width: `${zoom * 100}%` }}>
            {/* Plain img: photos come from our own /api/images route. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={alt} className="block w-full" />
            <span className={shade} style={{ top: 0, left: 0, right: 0, height: `${cut.top}%` }} />
            <span className={shade} style={{ bottom: 0, left: 0, right: 0, height: `${cut.bottom}%` }} />
            <span className={shade} style={{ top: `${cut.top}%`, bottom: `${cut.bottom}%`, left: 0, width: `${cut.left}%` }} />
            <span className={shade} style={{ top: `${cut.top}%`, bottom: `${cut.bottom}%`, right: 0, width: `${cut.right}%` }} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" className="flex-1" disabled={zoom === ZOOMS[0]}
            onClick={() => setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)]!)}>Smaller</Button>
          <p className="min-w-20 text-center text-sm text-muted" aria-live="polite">{zoom === 1 ? "Normal size" : `${zoom} times`}</p>
          <Button type="button" variant="secondary" className="flex-1" disabled={zoom === ZOOMS[ZOOMS.length - 1]}
            onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)]!)}>Bigger</Button>
        </div>
        <p className="text-xs text-muted">You can also pinch the screen to zoom.</p>
      </div>

      <form action={turnAction} className="flex flex-col gap-2">
        <input type="hidden" name="itemId" value={itemId} />
        <input type="hidden" name="imageId" value={imageId} />
        <input type="hidden" name="kind" value="turn" />
        <h2 className="text-lg font-semibold">Turn</h2>
        <div className="flex gap-2">
          <Button type="submit" name="direction" value="left" variant="secondary" className="flex-1" disabled={working}>Turn left</Button>
          <Button type="submit" name="direction" value="right" variant="secondary" className="flex-1" disabled={working}>Turn right</Button>
        </div>
        <Result state={turnState} />
      </form>

      <form action={trimAction} className="flex flex-col gap-3">
        <input type="hidden" name="itemId" value={itemId} />
        <input type="hidden" name="imageId" value={imageId} />
        <input type="hidden" name="kind" value="trim" />
        <h2 className="text-lg font-semibold">Trim</h2>
        <p className="text-sm text-muted">Cut away the edges you do not want. The dark parts above show what will go.</p>
        {SIDES.map(([side, label]) => (
          <div key={side} className="flex flex-col gap-1">
            <label htmlFor={`trim-${side}`} className="flex justify-between text-sm font-semibold">
              <span>{label}</span>
              <span className="text-muted">{cut[side]} percent</span>
            </label>
            <input
              id={`trim-${side}`} name={side} type="range" min={0} max={40} step={1} value={cut[side]}
              className="h-11 w-full accent-accent" disabled={working}
              onChange={(e) => setCut((c) => ({ ...c, [side]: Number(e.target.value) }))}
            />
          </div>
        ))}
        <div className="flex gap-2">
          <Button type="submit" className="flex-1" disabled={working || !anyCut}>Trim the photo</Button>
          <Button type="button" variant="secondary" disabled={working || !anyCut} onClick={() => setCut({ top: 0, bottom: 0, left: 0, right: 0 })}>Clear</Button>
        </div>
        <Result state={trimState} />
      </form>

      {working ? <p role="status" className="text-sm text-muted">Working on the photo. This takes a few seconds.</p> : null}

      {hasOriginal ? (
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">The original</h2>
          {asking ? (
            <form action={restoreAction} className="flex flex-col gap-3">
              <input type="hidden" name="itemId" value={itemId} />
              <input type="hidden" name="imageId" value={imageId} />
              <p role="alert" className="text-sm font-semibold">Go back to the photo as it was? The turning and trimming you did are removed.</p>
              <div className="flex gap-2">
                <Button type="submit" className="flex-1" disabled={working}>Yes, go back</Button>
                <Button type="button" variant="secondary" className="flex-1" disabled={working} onClick={() => setAsking(false)}>Cancel</Button>
              </div>
            </form>
          ) : (
            <Button type="button" variant="secondary" className="w-full" disabled={working} onClick={() => setAsking(true)}>Back to the original photo</Button>
          )}
          <Result state={restoreState} />
        </div>
      ) : (
        <p className="text-sm text-muted">The first time you turn or trim, the photo as it is now is kept so you can go back to it.</p>
      )}

      {canReplace ? <PhotoUpload itemId={itemId} mode="replace" imageId={imageId} title="Replace this photo" /> : null}
    </div>
  );
}

function Result({ state }: { state: PhotoState }) {
  if (state.status === "idle") return null;
  return state.status === "error"
    ? <p role="alert" className="text-sm text-danger">{state.message}</p>
    : <p role="status" className="text-sm text-accent">{state.message}</p>;
}
