/* The taskboard now uses only project roles. These legacy account columns are no longer needed. */
IF COL_LENGTH(N'taskboard.users', N'password_hash') IS NOT NULL
    ALTER TABLE taskboard.users DROP COLUMN password_hash;
GO

IF COL_LENGTH(N'taskboard.users', N'is_system_admin') IS NOT NULL
BEGIN
    DECLARE @defaultConstraint SYSNAME;
    DECLARE @dropConstraintSql NVARCHAR(512);
    SELECT @defaultConstraint = dc.name
    FROM sys.default_constraints dc
    INNER JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'taskboard.users') AND c.name = N'is_system_admin';

    IF @defaultConstraint IS NOT NULL
    BEGIN
        SET @dropConstraintSql = N'ALTER TABLE taskboard.users DROP CONSTRAINT ' + QUOTENAME(@defaultConstraint);
        EXEC sys.sp_executesql @dropConstraintSql;
    END;

    ALTER TABLE taskboard.users DROP COLUMN is_system_admin;
END;
GO
