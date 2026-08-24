import { NavLink, Route, Routes } from 'react-router-dom';
import { MapPage } from './pages/MapPage.js';
import { PlotsPage } from './pages/PlotsPage.js';

export function App() {
  return (
    <div className="app">
      <nav className="topnav">
        <span className="brand">Plot Marker</span>
        <NavLink to="/" end>
          Map
        </NavLink>
        <NavLink to="/plots">Plots</NavLink>
      </nav>
      <Routes>
        <Route path="/" element={<MapPage />} />
        <Route path="/plots" element={<PlotsPage />} />
      </Routes>
    </div>
  );
}
