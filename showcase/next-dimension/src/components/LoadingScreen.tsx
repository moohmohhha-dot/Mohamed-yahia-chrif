/** Minimal, non-blocking loader shown while the 3D chunk downloads. */
export default function LoadingScreen() {
  return (
    <div className="loader" role="status" aria-live="polite">
      <span className="loader__line" aria-hidden="true" />
      <span className="loader__text">PREPARING THE SHOWROOM</span>
    </div>
  );
}
