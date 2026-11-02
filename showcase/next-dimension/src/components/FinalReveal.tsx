import { brand, finale } from '../data/product';
import { useUI } from '../lib/store';
import MagneticButton from './MagneticButton';
import { Wordmark } from './Navigation';

export default function FinalReveal() {
  const replay = useUI((s) => s.replayIntro);
  return (
    <section id="final" data-section="final" data-kf="final" className="chapter chapter--final" aria-labelledby="final-title">
      <div className="final">
        <Wordmark className="final__wordmark js-fade" />
        <h2 id="final-title" className="final__title js-fade">
          <span>{finale.lineOne}</span>
          <span className="final__sub">{finale.lineTwo}</span>
        </h2>
        <div className="js-fade">
          <MagneticButton variant="ghost" onClick={replay}>
            <span className="btn__arrow" aria-hidden="true">↺</span>
            {finale.replay}
          </MagneticButton>
        </div>
      </div>
      <footer className="footer">
        <span>© {brand.year} {brand.name} — {brand.project}</span>
        <span>{brand.disclaimer}</span>
        <span>Samsung and Galaxy are trademarks of their respective owner, used here only to identify the featured product.</span>
      </footer>
    </section>
  );
}
