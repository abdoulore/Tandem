import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { Landing } from "./pages/Landing";
import { Markets } from "./pages/Markets";
import { Order } from "./pages/Order";
import { Radar } from "./pages/Radar";
import { Switches } from "./pages/Switches";
import { AppDataProvider } from "./state/AppData";

/** Old /app/switches links (Telegram, bookmarks) land on My orders with their query intact. */
function ToOrders() {
  const { search } = useLocation();
  return <Navigate to={`/app/orders${search}`} replace />;
}

export function App() {
  return (
    <AppDataProvider>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/radar" element={<Radar />} />
        <Route path="/app" element={<AppShell />}>
          <Route index element={<Order />} />
          <Route path="orders" element={<Switches />} />
          <Route path="switches" element={<ToOrders />} />
          <Route path="markets" element={<Markets />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppDataProvider>
  );
}
