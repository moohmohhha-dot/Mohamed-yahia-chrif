import { finishes } from '../data/product';
import { useUI } from '../lib/store';
import { audio } from '../lib/audio';

type Props = { size?: 'compact' | 'large'; id: string };

/** Finish picker. Changes the real 3D materials and lighting; the view angle is untouched. */
export default function ColorSelector({ size = 'large', id }: Props) {
  const finishId = useUI((s) => s.finishId);
  const setFinish = useUI((s) => s.setFinish);
  const current = finishes.find((f) => f.id === finishId) ?? finishes[0];

  return (
    <div className={`finish finish--${size}`}>
      <div className="finish__swatches" role="radiogroup" aria-labelledby={`${id}-label`}>
        <span id={`${id}-label`} className="finish__label">
          FINISH <b>{current.name}</b>
        </span>
        {finishes.map((f, i) => {
          const selected = f.id === finishId;
          return (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={f.name}
              tabIndex={selected ? 0 : -1}
              className={`swatch${selected ? ' is-selected' : ''}`}
              style={{ ['--swatch' as string]: f.swatch }}
              onPointerEnter={() => audio.tick(0, 1.6)}
              onClick={() => {
                audio.tick(0, 0.9 + i * 0.15);
                setFinish(f.id);
              }}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                e.preventDefault();
                const next = (i + (e.key === 'ArrowRight' ? 1 : -1) + finishes.length) % finishes.length;
                setFinish(finishes[next].id);
                const group = e.currentTarget.parentElement;
                group?.querySelectorAll<HTMLButtonElement>('.swatch')[next]?.focus();
              }}
            >
              <span className="swatch__chip" aria-hidden="true" />
              {size === 'large' && <span className="swatch__name">{f.name}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
