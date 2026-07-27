self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.accountability-companion;
in
{
  options.services.accountability-companion = {
    enable = lib.mkEnableOption "the accountability companion (per-user systemd service)";

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
        companion is not reachable, so a companion you have to remember to
        start is a companion that is not running when it matters.
      '';
    };

    users = lib.mkOption {
      type = lib.types.nullOr (lib.types.listOf lib.types.str);
      default = null;
      example = [ "alice" ];
      description = ''
        Restrict the user service to these accounts. `null` (the default)
        enables it for every user who logs in — harmless, since the companion
        does nothing at all until that user runs `accountability-companion
        setup`.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];

    # Makes the unpacked extension reachable at the stable system path
    # /run/current-system/sw/share/accountability-blocker/extension, which is
    # what you want to give Chrome — it survives every rebuild.
    environment.pathsToLink = [ "/share/accountability-blocker" ];

    systemd.user.services.accountability-companion = {
      description = "Accountability companion (local blocklist, vault and check-in)";
      documentation = [ "https://github.com/0xLysandre/Don-t-Masturbate" ];
      wantedBy = lib.optional cfg.autoStart "default.target";

      # Nothing to wait for: it binds loopback and touches only $HOME.
      serviceConfig = {
        Type = "simple";
        ExecStart = "${lib.getExe cfg.package} serve";
        Restart = "always";
        RestartSec = 3;

        # It only ever needs its own state directory and a loopback socket.
        PrivateTmp = true;
        ProtectHostname = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictNamespaces = true;
        RestrictRealtime = true;
        LockPersonality = true;
        MemoryDenyWriteExecute = false; # V8 JITs
        SystemCallArchitectures = "native";
        RestrictAddressFamilies = "AF_UNIX AF_INET AF_INET6";
      };

      unitConfig = lib.mkIf (cfg.users != null) {
        ConditionUser = cfg.users;
      };
    };
  };
}
