import { createElement } from 'react';

type Props = { text: string; as?: 'h1' | 'h2' | 'h3' | 'p' | 'span'; className?: string; id?: string };

/** Renders text as masked word spans so GSAP can reveal it word by word. */
export default function SplitWords({ text, as = 'h2', className = '', id }: Props) {
  const words = text.split(' ');
  return createElement(
    as,
    { className: `split ${className}`, id, 'aria-label': text },
    words.flatMap((w, i) => [
      <span className="split__mask" key={`${w}${i}`} aria-hidden="true">
        <span className="split__word">{w}</span>
      </span>,
      i < words.length - 1 ? ' ' : null,
    ]),
  );
}
