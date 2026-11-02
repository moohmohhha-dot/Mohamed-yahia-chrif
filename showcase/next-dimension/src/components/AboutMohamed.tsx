import { brand, creator } from '../data/product';
import SplitWords from './SplitWords';
import { Wordmark } from './Navigation';

export default function AboutMohamed() {
  return (
    <section id="creator" data-section="creator" data-kf="creator" className="chapter chapter--creator" aria-labelledby="creator-title">
      <div className="about">
        <p className="copy__kicker js-fade">
          <span className="copy__index">07</span>
          {creator.kicker}
        </p>
        <Wordmark className="about__wordmark js-fade" />
        <SplitWords as="h2" text={creator.headline} className="about__title js-words" id="creator-title" />
        <p className="about__body js-fade">{creator.body}</p>
        <ul className="about__pillars">
          {creator.pillars.map((p, i) => (
            <li key={p.title} className="pillar js-fade">
              <span className="pillar__index">0{i + 1}</span>
              <h3 className="pillar__title">{p.title}</h3>
              <p className="pillar__text">{p.text}</p>
            </li>
          ))}
        </ul>
        <p className="about__note js-fade">
          An experimental, independent showcase. {brand.disclaimer}
        </p>
      </div>
    </section>
  );
}
