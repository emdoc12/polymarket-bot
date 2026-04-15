import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Search,
  Bot,
  History,
  Star,
  Settings,
  Sun,
  Moon,
  Activity,
} from "lucide-react";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const navItems = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/markets", label: "Markets", icon: Search },
  { path: "/strategies", label: "Strategies", icon: Bot },
  { path: "/trades", label: "Trade Log", icon: History },
  { path: "/watchlist", label: "Watchlist", icon: Star },
  { path: "/settings", label: "Settings", icon: Settings },
];

export function AppSidebar() {
  const [location] = useLocation();
  const { theme, toggleTheme } = useTheme();

  return (
    <aside className="w-56 shrink-0 border-r border-sidebar-border bg-sidebar flex flex-col h-screen sticky top-0">
      {/* Logo */}
      <div className="px-4 py-4 border-b border-sidebar-border">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <Activity className="w-4 h-4 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight">PolyBot</h1>
            <p className="text-[11px] text-muted-foreground leading-none">Trading Automator</p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = location === item.path || (item.path !== "/" && location.startsWith(item.path));
          return (
            <Link key={item.path} href={item.path}>
              <div
                data-testid={`nav-${item.label.toLowerCase().replace(/\s/g, '-')}`}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm cursor-pointer transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                )}
              >
                <item.icon className="w-4 h-4 shrink-0" />
                {item.label}
              </div>
            </Link>
          );
        })}
      </nav>

      {/* Theme toggle */}
      <div className="px-3 py-3 border-t border-sidebar-border">
        <button
          onClick={toggleTheme}
          data-testid="button-theme-toggle"
          className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/50 w-full transition-colors"
        >
          {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          {theme === "dark" ? "Light Mode" : "Dark Mode"}
        </button>
      </div>
    </aside>
  );
}
