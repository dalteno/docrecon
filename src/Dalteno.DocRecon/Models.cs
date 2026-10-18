using System.Text.Json;
using System.Text.Json.Serialization;

namespace Dalteno.DocRecon;

/// <summary>
/// Document models. Numeric fields are kept as <see cref="string"/> on purpose: the engine parses them itself into
/// integer minor units (ADR-0002) so that "1,200.00", 1200 and "1200.0" are treated identically and a non-numeric
/// value becomes a finding (R21) instead of a deserialisation exception.
/// </summary>
public sealed class Bundle
{
    public Invoice? Invoice { get; set; }
    public PackingList? PackingList { get; set; }
    public BillOfLading? BillOfLading { get; set; }
}

/// <summary>Commercial invoice.</summary>
public sealed class Invoice
{
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Number { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Date { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Currency { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Incoterm { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Seller { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Buyer { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Total { get; set; }
    [JsonConverter(typeof(TolerantListConverter<InvoiceLine>))] public List<InvoiceLine>? Lines { get; set; }
}

/// <summary>One invoice line.</summary>
public sealed class InvoiceLine
{
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Sku { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Description { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Qty { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Unit { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? UnitPrice { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? LineTotal { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? HsCode { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Currency { get; set; }
}

/// <summary>Packing list.</summary>
public sealed class PackingList
{
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Number { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Date { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? InvoiceRef { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? ShipmentRef { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? TotalPackages { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? TotalNetKg { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? TotalGrossKg { get; set; }
    [JsonConverter(typeof(TolerantListConverter<PackingLine>))] public List<PackingLine>? Lines { get; set; }
}

/// <summary>One packing-list line.</summary>
public sealed class PackingLine
{
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Sku { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Qty { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Unit { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Packages { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? NetKg { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? GrossKg { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? HsCode { get; set; }
}

/// <summary>Bill of lading (sea) — the "shipped on board" document.</summary>
public sealed class BillOfLading
{
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Number { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Date { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? ShipmentRef { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Shipper { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Consignee { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? Packages { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? GrossKg { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? PortOfLoading { get; set; }
    [JsonConverter(typeof(FlexibleStringConverter))] public string? PortOfDischarge { get; set; }
}

/// <summary>Accepts JSON strings, numbers, booleans and null for a <see cref="string"/> property (raw text is preserved).</summary>
public sealed class FlexibleStringConverter : JsonConverter<string?>
{
    /// <inheritdoc />
    public override string? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) => reader.TokenType switch
    {
        JsonTokenType.String => reader.GetString(),
        JsonTokenType.Number => System.Text.Encoding.UTF8.GetString(reader.ValueSpan),
        JsonTokenType.True => "true",
        JsonTokenType.False => "false",
        JsonTokenType.Null => null,
        _ => throw new JsonException($"Unexpected token {reader.TokenType} for a scalar field."),
    };

    /// <inheritdoc />
    public override void Write(Utf8JsonWriter writer, string? value, JsonSerializerOptions options)
    {
        if (value is null) writer.WriteNullValue(); else writer.WriteStringValue(value);
    }
}

/// <summary>A list that tolerates a non-array token (object, string, number): it is skipped and read as null, so the engine reports R21 instead of throwing.</summary>
public sealed class TolerantListConverter<T> : JsonConverter<List<T>?>
{
    /// <inheritdoc />
    public override List<T>? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null) return null;
        if (reader.TokenType != JsonTokenType.StartArray) { reader.Skip(); return null; }
        return JsonSerializer.Deserialize<List<T>>(ref reader, options);
    }

    /// <inheritdoc />
    public override void Write(Utf8JsonWriter writer, List<T>? value, JsonSerializerOptions options) => JsonSerializer.Serialize(writer, value, options);
}

/// <summary>Shared JSON options: camelCase, case-insensitive, matching the JS engine's input format.</summary>
public static class Json
{
    /// <summary>Serializer options used for bundles, reports and shared cases.</summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        WriteIndented = false,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        Converters = { new JsonStringEnumConverter() },
    };
}
