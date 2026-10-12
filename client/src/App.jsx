import { NavLink, Route, Routes } from 'react-router-dom';
import Check from './pages/Check.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Review from './pages/Review.jsx';
import Policies from './pages/Policies.jsx';

export default function App() {
  return (
    <>
      <header className="topbar">
        <div className="brand">⚖️ Contract Risk Analyzer</div>
        <nav>
          <NavLink to="/" end>Check a clause</NavLink>
          <NavLink to="/contracts">Contracts</NavLink>
          <NavLink to="/policies">Policies</NavLink>
        </nav>
      </header>
      <main className="container">
        <Routes>
          <Route path="/" element={<Check />} />
          <Route path="/contracts" element={<Dashboard />} />
          <Route path="/contracts/:id" element={<Review />} />
          <Route path="/policies" element={<Policies />} />
        </Routes>
      </main>
    </>
  );
}