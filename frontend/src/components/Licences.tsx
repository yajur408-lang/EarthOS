import { SOFTWARE, SOURCES } from '../licences'

export default function Licences({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Data sources and licences" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Data sources &amp; licences</h2>
          <button className="ghost icon" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <p className="hint">Every source in use permits commercial use with attribution. No API keys are sent to the browser.</p>
        <div className="sources">
          {SOURCES.map((s) => (
            <article key={s.name} className={`source ${s.status.replace(' ', '-')}`}>
              <div className="source-head">
                <strong>{s.name}</strong>
                <em className={`pill ${s.status === 'in use' ? 'strong' : s.status === 'planned' ? 'moderate' : 'weak'}`}>{s.status}</em>
              </div>
              <span>{s.role}</span>
              <dl>
                <dt>Licence</dt><dd>{s.licence}</dd>
                <dt>Commercial</dt><dd>{s.commercial}</dd>
                {s.attribution !== '-' && (<><dt>Attribution</dt><dd>{s.attribution}</dd></>)}
              </dl>
              <a href={s.link} target="_blank" rel="noreferrer">{s.link}</a>
            </article>
          ))}
        </div>
        <h3>Software</h3>
        <p className="hint">{SOFTWARE.map(([n, l]) => `${n} (${l})`).join(' · ')}</p>
      </div>
    </div>
  )
}
