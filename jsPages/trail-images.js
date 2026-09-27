// trail-images.js
// The photo shown for a trail: its uploaded image if it has one, otherwise a
// bundled photo matched by trail name, otherwise the portal background.
// Used by Trail Management and the Dashboard's Trail Status Overview.

const TRAIL_IMAGES = {
  'Makiling Botanic Gardens Trail': '../assets/images/botanicGarden.jpg',
  'Makiling Traverse (MakTrav)': '../assets/images/makilingTraverse.jpg',
  'Sipit Trail': '../assets/images/sipitTrail.jpg',
  'Mariang Makiling Trail': '../assets/images/mariangMakiling.jpg'
};
const DEFAULT_TRAIL_IMAGE = '../assets/images/bg.png';

export function getTrailImage(trail) {
  return trail.imageUrl || trail.imageURL || trail.ImageUrl || trail.photoUrl || trail.photoURL || trail.PhotoUrl
    || TRAIL_IMAGES[trail.Trail] || DEFAULT_TRAIL_IMAGE;
}
