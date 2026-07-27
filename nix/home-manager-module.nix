self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.accountability-companion;
  extensionSource = "${cfg.package}/share/accountability-blocker/extension";
in
{
  options.services.accountability-companion = {
    enable = lib.mkEnableOption "the accountability companion";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalMD "the flake's `packages.<system>.default`";
      description = ''
        The companion package. Override it to change the loopback port, which
        rewrites the extension to match:
        `pkgs.callPackage "''${inputs.accountability}/nix/package.nix" { port = 7400; }`.
      '';
    };

    autoStart = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Start the companion on login. Leaving this on is the point: the
        extension shows a red "protection inactive" badge whenever the
        companion is not reachable.
      '';
    };

    linkExtension = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Symlink the unpacked extension to
        {file}`$XDG_DATA_HOME/accountability-blocker/extension`. Give that path
        to chrome://extensions → Load unpacked: it stays valid across rebuilds
        even though the store path underneath it changes.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    xdg.dataFile."accountability-blocker/extension" = lib.mkIf cfg.linkExtension {
      source = extensionSource;
    };

    systemd.user.services.accountability-companion = {
      Unit = {
        Description = "Accountability companion (local blocklist, vault and check-in)";
        Documentation = [ "https://github.com/0xLysandre/Don-t-Masturbate" ];
      };

      Service = {
        Type = "simple";
        ExecStart = "${lib.getExe cfg.package} serve";
        Restart = "always";
        RestartSec = 3;
      };

      Install = lib.mkIf cfg.autoStart {
        WantedBy = [ "default.target" ];
      };
    };
  };
}
